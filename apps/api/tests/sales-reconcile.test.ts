/**
 * The /reconcile routes on a real database (spec-reconcile §10.3, R-1…R-28): Form 26AS uploads and
 * the TDS view built from real receipts, GSTR-1 uploads against issued documents, client balance
 * confirmations. Documents are made through the real routes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import request from "supertest";
import { prisma } from "@dashmani/db";
import { todayIST } from "@dashmani/shared";

const sent: Array<{ to: string; cc?: string; subject: string; attachments?: Array<{ filename: string; content: Buffer }> }> = [];
let emailMode: "ok" | "fail" | "slow" = "ok";
let inFlight = 0;
let maxInFlight = 0;
vi.mock("../src/services/email.service", async (orig) => {
  const real = await orig<typeof import("../src/services/email.service")>();
  return {
    ...real,
    sendEmail: vi.fn(async (o: (typeof sent)[number]) => {
      if (emailMode === "fail" && o.subject.startsWith("Balance confirmation")) return null;
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      if (emailMode === "slow") await new Promise((r) => setTimeout(r, 60));
      inFlight--;
      sent.push(o);
      return { messageId: "test" };
    }),
  };
});

import app from "../src/app";
import { flushSalesBackground } from "../src/services/sales/common";
import { withParseSlot } from "../src/services/sales/recon/read";
import { buildGstCsv } from "../src/services/sales/accounts.service";
import { createTestRole, createTestUser, generateClientToken, generateHrToken, generateToken } from "./helpers";
import { SAMPLE_26AS, gstr1OctoberJson } from "./recon-fixtures";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const R = (rupees: number) => Math.round(rupees * 100);
const TODAY = todayIST();
const MUMBAI = "27AAKCD3352K1ZF";
const GURUGRAM = "06AAKCD3352K1ZJ";
const SELLER = {
  legalName: "Digital Sukoon Private Limited", gstin: MUMBAI, pan: "AAKCD3352K", addressLine1: "702, Parinee I, Andheri West", city: "Mumbai",
  state: "Maharashtra", stateCode: "27", pincode: "400053", invoicePrefix: "INV", creditNotePrefix: "CN", serialDigits: 4, defaultDueDays: 15,
  email: "accounts@ds.test", billingEmails: ["finance@ds.test"],
  branches: [{ label: "Gurugram", gstin: GURUGRAM, addressLine1: "Hunch Circle, Sector 29", city: "Gurugram", pincode: "122001", invoicePrefix: "INV", creditNotePrefix: "CNHR", serialDigits: 3 }],
};
const DMPL = {
  legalName: "Dashmani Media Private Limited", gstin: "27AAJCD7425L1Z8", pan: "AAJCD7425L", addressLine1: "Off-702 Parinee I", city: "Mumbai",
  stateCode: "27", pincode: "400053", invoicePrefix: "DM", creditNotePrefix: "DMCN", quotePrefix: "DMQ", orderPrefix: "DMSO", receiptPrefix: "DMRC", email: "accounts@dm.test",
};

interface World { sales: string; viewer: string; admin: string; employee: string; hr: string; clientTok: string; c: Record<string, string> }

async function seedWorld(): Promise<World> {
  sent.length = 0; emailMode = "ok"; inFlight = 0; maxInFlight = 0;
  await prisma.systemSetting.deleteMany({ where: { key: { startsWith: "sales.seller" } } });
  await createTestRole("Sales", ["view", "manage"].map((action) => ({ resource: "sales", action, scope: "global" })));
  await createTestRole("Viewer", [{ resource: "sales", action: "view", scope: "global" }]);
  await createTestRole("Admin", ["view", "manage", "approve"].map((action) => ({ resource: "sales", action, scope: "global" })));
  await createTestRole("Employee", [{ resource: "attendance", action: "view", scope: "own" }]);
  const s = await createTestUser({ roleNames: ["Sales"] });
  const v = await createTestUser({ roleNames: ["Viewer"] });
  const a = await createTestUser({ roleNames: ["Admin"] });
  const e = await createTestUser({ roleNames: ["Employee"] });
  const admin = generateToken(a.id, a.email, ["Admin"]);
  for (const [body, company] of [[SELLER, "dspl"], [DMPL, "dmpl"]] as const) {
    const r = await request(app).put(`/v1/sales/settings/seller?company=${company}`).set(auth(admin)).send(body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  const client = async (name: string, legalName: string | null, profile: Record<string, unknown> = {}) => {
    const c = await prisma.client.create({ data: { companyName: name, contactName: "X", email: `${name.replace(/\W/g, "").toLowerCase()}@c.test`, passwordHash: "x" } });
    if (legalName) await prisma.clientBillingProfile.create({ data: { clientId: c.id, legalName, addressLine1: "Street 1", city: "City", pincode: "400001", ...profile } });
    return c.id;
  };
  const c = {
    filmy: await client("Filmy Brands", "Filmy Brands Pvt. Ltd.", { gstin: "27AABCU9603R1ZX", stateCode: "27", state: "Maharashtra", billingEmail: "accounts@filmy.test" }),
    kanara: await client("Kanara Foods", "Kanara Foods Private Limited", { gstin: "29AAACB1234F1Z9", stateCode: "29", state: "Karnataka" }),
    hunch: await client("Hunch Media", "Hunch Media LLP", { gstin: "06AABCH1234M1Z5", stateCode: "06", state: "Haryana" }),
    moon: await client("Moonlight Studios", "Moonlight Studios", { stateCode: "27", state: "Maharashtra" }),
    red: await client("Red Chilli", "Red Chilli Entertainment Private Limited", { stateCode: "27", state: "Maharashtra" }),
    orbit: await client("Orbit Ads", "Orbit Ads LLP", { gstin: "27AAJFO1111K1Z5", stateCode: "27", state: "Maharashtra" }),
  };
  const clientTok = generateClientToken(c.filmy, "filmybrands@c.test");
  return { sales: generateToken(s.id, s.email, ["Sales"]), viewer: generateToken(v.id, v.email, ["Viewer"]), admin, employee: generateToken(e.id, e.email, ["Employee"]), hr: generateHrToken(s.id, s.email, ["Sales"]), clientTok, c };
}

function api(w: () => World) {
  const post = (p: string, body: unknown, t = w().sales) => request(app).post(`/v1${p}`).set(auth(t)).send(body as object);
  async function issue(clientId: string, o: { day: string; price: number; number?: string; company?: string; due?: string }) {
    const d = await post("/sales/invoices", { companyKey: o.company ?? "dspl", kind: "tax_invoice", clientId, issueDate: o.day, dueDate: o.due ?? null, items: [{ description: "Campaign", quantity: 1, unitPricePaise: o.price }] });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    const r = await post(`/sales/invoices/${d.body.data.id}/issue`, { issueDate: o.day, number: o.number ?? null, ...(o.due ? { dueDate: o.due } : {}), taxResolution: "keep" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data as { id: string; number: string; totalPaise: number; taxablePaise: number };
  }
  async function pay(clientId: string, o: { amount: number; tds?: number; day: string; company?: string; allocs?: Array<{ invoiceId: string; amountPaise: number; tdsPaise?: number }> }) {
    const r = await post("/sales/payments", { companyKey: o.company ?? "dspl", clientId, amountPaise: o.amount, tdsPaise: o.tds ?? 0, mode: "bank_transfer", paidOn: o.day, allocations: o.allocs ?? [] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.data as { id: string; number: string };
  }
  const get = (p: string, t = w().sales) => request(app).get(`/v1${p}`).set(auth(t));
  const upload = (p: string, buf: Buffer, name: string, fields: Record<string, string>, t = w().sales) => {
    let r = request(app).post(`/v1${p}`).set(auth(t));
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    return r.attach("file", buf, name);
  };
  return { post, get, issue, pay, upload };
}

/** The §5.1.7 books: six invoices with receipts carrying TDS. */
async function seedTdsBooks(a: ReturnType<typeof api>, c: World["c"]) {
  const b = async (cl: string, issueDay: string, taxable: number, paid: string, tds: number) => {
    const inv = await a.issue(cl, { day: issueDay, price: R(taxable) });
    const p = await a.pay(cl, { amount: inv.totalPaise - R(tds), tds: R(tds), day: paid, allocs: [{ invoiceId: inv.id, amountPaise: inv.totalPaise - R(tds), tdsPaise: R(tds) }] });
    return { inv, p };
  };
  return {
    b1: await b(c.filmy, "2025-09-20", 100000, "2025-10-03", 10000),
    b2: await b(c.filmy, "2025-12-01", 50000, "2025-12-15", 5000),
    b3: await b(c.kanara, "2025-12-22", 200000, "2026-01-10", 4000),
    b4: await b(c.hunch, "2026-02-05", 50000, "2026-02-14", 1180),
    b5: await b(c.moon, "2026-03-02", 30000, "2026-03-20", 3000),
    b6: await b(c.filmy, "2026-03-25", 40000, "2026-04-12", 4000),
  };
}

const MONEY_TABLES = ["sales_invoices", "sales_invoice_items", "sales_payments", "sales_payment_allocations", "sales_credit_notes", "sales_refunds", "sales_sequences"];
async function moneySnapshot() {
  const out: Record<string, string> = {};
  for (const t of MONEY_TABLES) {
    const col = t === "sales_invoice_items" || t === "sales_payment_allocations" ? "id" : t === "sales_sequences" || t === "sales_invoices" ? "updated_at" : "created_at";
    const [r] = await prisma.$queryRawUnsafe<Array<{ n: bigint; m: unknown }>>(`SELECT count(*) AS n, max(${col})::text AS m FROM ${t}`);
    out[t] = `${r.n}|${r.m}`;
  }
  return out;
}

function listFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === ".turbo") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, out); else out.push(p);
  }
  return out;
}

// ─── TDS ─────────────────────────────────────────────────────────────────────────────────────

describe("reconcile — TDS · 26AS", () => {
  let world: World;
  const a = api(() => world);
  beforeEach(async () => { world = await seedWorld(); });

  it("R-1 gates: employee / HR / client 403; viewer reads but cannot write; a 10 MB body from a viewer is refused before buffering", async () => {
    const gets = ["/sales/reconcile/tds?fy=2025-26", "/sales/reconcile/gst?period=2026-10", "/sales/reconcile/confirmations", `/sales/reconcile/ledger?clientId=${world.c.filmy}`];
    for (const t of [world.employee, world.hr, world.clientTok]) for (const g of gets) expect((await a.get(g, t)).status, g).toBe(403);
    for (const g of gets) expect((await a.get(g, world.viewer)).status, g).toBe(200);
    expect((await a.upload("/sales/reconcile/tds/uploads", Buffer.from(SAMPLE_26AS), "26as.txt", { fy: "2025-26" }, world.viewer)).status).toBe(403);
    expect((await a.post(`/sales/reconcile/tds/deductors/MUMH03189E`, { kind: "non_sales", label: "Bank interest" }, world.viewer)).status).toBe(404); // PUT only
    expect((await request(app).put("/v1/sales/reconcile/tds/deductors/MUMH03189E").set(auth(world.viewer)).send({ kind: "non_sales", label: "Bank interest" })).status).toBe(403);
    expect((await a.post("/sales/reconcile/confirmations", { companyKey: "dspl", clientId: world.c.filmy, asOf: TODAY, from: "2026-04-01" }, world.viewer)).status).toBe(403);
    const big = await a.upload("/sales/reconcile/tds/uploads", Buffer.alloc(10 * 1024 * 1024, 65), "big.txt", { fy: "2025-26" }, world.viewer);
    expect(big.status).toBe(403);
  });

  it("R-2 / R-6 / R-9 upload: entries stored, events, nothing on disk; sure TANs learned; the view reproduces T-1 from real receipts", async () => {
    await seedTdsBooks(a, world.c);
    const uploadsDir = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");
    const before = [...listFiles(uploadsDir), ...listFiles(process.cwd())].sort();
    expect((await request(app).put("/v1/sales/reconcile/tds/deductors/MUMH03189E").set(auth(world.sales)).send({ kind: "non_sales", label: "Bank interest — HDFC FD" })).status).toBe(200);
    const up = await a.upload("/sales/reconcile/tds/uploads", Buffer.from(SAMPLE_26AS), "26as.txt", { fy: "2025-26" });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body.data.upload).toMatchObject({ format: "26as_text", entryCount: 7, deductorCount: 6, pan: "AAKCD3352K", asOn: "2026-11-05", totals: { tdsPaise: R(31750), depositedPaise: R(27750) } });
    expect(up.body.data.learned.map((l: { tan: string; where: string }) => `${l.tan}:${l.where}`).sort()).toEqual(["BLRK98765C:profile", "MUMF12345A:profile"]);
    const after = [...listFiles(uploadsDir), ...listFiles(process.cwd())].sort();
    expect(after).toEqual(before);
    expect(await prisma.salesTdsEntry.count()).toBe(7);
    expect((await prisma.clientBillingProfile.findUnique({ where: { clientId: world.c.filmy } }))!.tan).toBe("MUMF12345A");
    expect(await prisma.salesEvent.count({ where: { entityType: "client", action: "tan_learned" } })).toBe(2);
    expect(await prisma.salesEvent.count({ where: { entityType: "tds_upload", action: "uploaded" } })).toBe(1);

    const v1 = (await a.get("/sales/reconcile/tds?fy=2025-26")).body.data;
    expect(v1.totals.chasePaise).toBe(R(7000));
    expect(v1.deductors.find((d: { tan: string }) => d.tan === "DELH55555E").proposal).toMatchObject({ clientId: world.c.hunch, sure: false });
    for (const [tan, id] of [["DELH55555E", world.c.hunch], ["DELR77777Z", world.c.red]]) {
      const r = await request(app).put(`/v1/sales/reconcile/tds/deductors/${tan}`).set(auth(world.sales)).send({ kind: "client", clientId: id, nameSeen: "x" });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const v = (await a.get("/sales/reconcile/tds?fy=2025-26")).body.data;
    expect(v.totals).toMatchObject({ booksPaise: R(27180), booksByReceiptDatePaise: R(23180), deductedPaise: R(31750), depositedPaise: R(27750), matchedPaise: R(19000), chasePaise: R(7180), chaseCount: 3, extraPaise: R(8000), unknownPaise: R(2500), nonSalesPaise: R(1250), nextYearPaise: R(4000) });
    const acc = (await a.get("/sales/accounts?company=dspl&fy=2025-26")).body.data;
    expect(acc.tds.totalPaise).toBe(v.totals.booksByReceiptDatePaise);
    const dm = (await a.get("/sales/reconcile/tds?fy=2025-26&company=dmpl")).body.data;
    expect(dm.totals.booksPaise).toBe(0);
  });

  it("R-9 a voided receipt's TDS is excluded (R→G)", async () => {
    const books = await seedTdsBooks(a, world.c);
    await a.upload("/sales/reconcile/tds/uploads", Buffer.from(SAMPLE_26AS), "26as.txt", { fy: "2025-26" });
    const before = (await a.get("/sales/reconcile/tds?fy=2025-26")).body.data;
    expect(before.totals.booksPaise).toBe(R(27180));
    expect((await a.post(`/sales/payments/${books.b5.p.id}/void`, { reason: "bounced cheque" })).status).toBe(200);
    const after = (await a.get("/sales/reconcile/tds?fy=2025-26")).body.data;
    expect(after.totals.booksPaise).toBe(R(24180));
    expect(after.rows.some((r: { clientId: string }) => r.clientId === world.c.moon)).toBe(false);
  });

  it("R-3 idempotency: same file → duplicate; another current; first again → madeCurrent", async () => {
    const f1 = Buffer.from(SAMPLE_26AS);
    const f2 = Buffer.from(SAMPLE_26AS.replace("^1^194J^18-Nov-2025^F^20-Jan-2026^-^25000.00^2500.00^2500.00", "^1^194J^18-Nov-2025^F^20-Jan-2026^-^25000.00^2500.00^2500.00\r\n"));
    expect((await a.upload("/sales/reconcile/tds/uploads", f1, "a.txt", { fy: "2025-26" })).status).toBe(201);
    const dup = await a.upload("/sales/reconcile/tds/uploads", f1, "a.txt", { fy: "2025-26" });
    expect(dup.status).toBe(200);
    expect(dup.body.data).toMatchObject({ duplicate: true, madeCurrent: false });
    expect(await prisma.salesTdsUpload.count()).toBe(1);
    const second = await a.upload("/sales/reconcile/tds/uploads", f2, "b.txt", { fy: "2025-26" });
    expect(second.status).toBe(201);
    const again = await a.upload("/sales/reconcile/tds/uploads", f1, "a.txt", { fy: "2025-26" });
    expect(again.body.data).toMatchObject({ duplicate: true, madeCurrent: true });
    expect(await prisma.salesEvent.count({ where: { entityType: "tds_upload", action: "made_current" } })).toBe(1);
    const v = (await a.get("/sales/reconcile/tds?fy=2025-26")).body.data;
    expect(v.upload.fileName).toBe("a.txt");
    expect(v.history).toHaveLength(2);
    const both = await Promise.all([
      a.upload("/sales/reconcile/tds/uploads", Buffer.from(SAMPLE_26AS + "\r\n "), "c.txt", { fy: "2025-26" }),
      a.upload("/sales/reconcile/tds/uploads", Buffer.from(SAMPLE_26AS + "\r\n  "), "d.txt", { fy: "2025-26" }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 201]);
  });

  it("R-4 refusals", async () => {
    const up = (buf: Buffer, name: string, fy = "2025-26") => a.upload("/sales/reconcile/tds/uploads", buf, name, { fy });
    expect((await up(Buffer.from(SAMPLE_26AS.replace("AAKCD3352K", "AAJCD7425L")), "26as.txt")).body.error.code).toBe("TDS_WRONG_PAN");
    const fy = await up(Buffer.from(SAMPLE_26AS), "26as.txt", "2024-25");
    expect(fy.body.error).toMatchObject({ code: "TDS_WRONG_FY", message: "This 26AS is for 2025-26 — choose 2025-26 above and upload it again." });
    const pdf = await up(Buffer.from("%PDF-1.4"), "26as.pdf");
    expect([pdf.status, pdf.body.error.code]).toEqual([415, "RECON_FILE_PDF"]);
    const zip = await up(Buffer.from("PK\u0003\u0004x"), "26as.zip");
    expect([zip.status, zip.body.error.code]).toEqual([415, "RECON_FILE_ZIP"]);
    const sniffed = await up(Buffer.from("%PDF-1.4 hidden"), "26as.txt");
    expect([sniffed.status, sniffed.body.error.code]).toEqual([415, "RECON_FILE_PDF"]);
    const big = await up(Buffer.alloc(10 * 1024 * 1024 + 1, 65), "26as.txt");
    expect([big.status, big.body.error.code]).toEqual([413, "FILE_TOO_LARGE"]);
    const none = await request(app).post("/v1/sales/reconcile/tds/uploads").set(auth(world.sales)).field("fy", "2025-26");
    expect([none.status, none.body.error.code]).toEqual([400, "NO_FILE"]);
    const s = JSON.parse((await prisma.systemSetting.findUnique({ where: { key: "sales.seller" } }))!.value);
    await prisma.systemSetting.update({ where: { key: "sales.seller" }, data: { value: JSON.stringify({ ...s, pan: null, gstin: null, branches: [] }) } });
    expect((await up(Buffer.from(SAMPLE_26AS), "26as.txt")).body.error.code).toBe("COMPANY_PAN_MISSING");
  });

  it("R-5 warnings need acceptWarnings; then stored", async () => {
    const bad = Buffer.from(SAMPLE_26AS.replace("1^FILMY BRANDS PRIVATE LIMITED^MUMF12345A^^^^^150000.00^15000.00", "1^FILMY BRANDS PRIVATE LIMITED^MUMF12345A^^^^^150000.00^16000.00"));
    const r1 = await a.upload("/sales/reconcile/tds/uploads", bad, "26as.txt", { fy: "2025-26" });
    expect([r1.status, r1.body.error.code]).toEqual([409, "WARNINGS_NOT_ACCEPTED"]);
    expect(r1.body.error.message).toContain("Press Upload anyway to keep it.");
    expect(await prisma.salesTdsUpload.count()).toBe(0);
    const r2 = await a.upload("/sales/reconcile/tds/uploads", bad, "26as.txt", { fy: "2025-26", acceptWarnings: "true" });
    expect(r2.status).toBe(201);
    expect(r2.body.data.upload.warnings[0]).toContain("FILMY BRANDS");
  });

  it("R-6 learning keeps an existing profile TAN (second TAN → deductors); a client without a profile → deductors (R→G)", async () => {
    await seedTdsBooks(a, world.c);
    await prisma.clientBillingProfile.update({ where: { clientId: world.c.filmy }, data: { tan: "MUMX00000A" } });
    await prisma.clientBillingProfile.delete({ where: { clientId: world.c.kanara } });
    await prisma.client.update({ where: { id: world.c.kanara }, data: { companyName: "Kanara Foods Pvt Ltd" } });
    const up = await a.upload("/sales/reconcile/tds/uploads", Buffer.from(SAMPLE_26AS), "26as.txt", { fy: "2025-26" });
    expect(up.body.data.learned.map((l: { tan: string; where: string }) => `${l.tan}:${l.where}`).sort()).toEqual(["BLRK98765C:deductors", "MUMF12345A:deductors"]);
    expect((await prisma.clientBillingProfile.findUnique({ where: { clientId: world.c.filmy } }))!.tan).toBe("MUMX00000A");
    expect(await prisma.salesTdsDeductor.findUnique({ where: { tan: "MUMF12345A" } })).toMatchObject({ clientId: world.c.filmy, kind: "client", source: "auto" });
  });

  it("R-7 mapping by hand: profile, no-op, TAN_TAKEN, TAN_FROM_PROFILE, non-sales needs a label, unmap event", async () => {
    const put = (tan: string, body: object) => request(app).put(`/v1/sales/reconcile/tds/deductors/${tan}`).set(auth(world.sales)).send(body);
    expect((await put("MUMF12345A", { kind: "client", clientId: world.c.filmy })).body.data).toEqual({ changed: true, where: "profile" });
    expect((await put("MUMF12345A", { kind: "client", clientId: world.c.filmy })).body.data).toEqual({ changed: false, where: "profile" });
    const taken = await put("MUMF12345A", { kind: "client", clientId: world.c.moon });
    expect([taken.status, taken.body.error.code, taken.body.error.message]).toEqual([409, "TAN_TAKEN", "MUMF12345A is already Filmy Brands' TAN — a TAN belongs to one deductor."]);
    const del = await request(app).delete("/v1/sales/reconcile/tds/deductors/MUMF12345A").set(auth(world.sales));
    expect([del.status, del.body.error.code]).toEqual([409, "TAN_FROM_PROFILE"]);
    expect((await put("MUMH03189E", { kind: "non_sales" })).status).toBe(400);
    expect((await put("MUMH03189E", { kind: "non_sales", label: "Bank interest — HDFC FD" })).body.data).toEqual({ changed: true, where: "deductors" });
    expect((await put("MUMH03189E", { kind: "client", clientId: world.c.moon })).body.error.code).toBe("TAN_TAKEN");
    expect((await request(app).delete("/v1/sales/reconcile/tds/deductors/MUMH03189E").set(auth(world.sales))).body.data).toEqual({ removed: true });
    expect(await prisma.salesEvent.count({ where: { entityType: "tds_deductor", action: { in: ["mapped", "marked_non_sales", "unmapped"] } } })).toBe(3);
  });

  it("R-8 billing profile TAN: upper-cased, malformed refused, another client's refused, null clears, never in an invoice snapshot (R→G)", async () => {
    const save = (id: string, tan: unknown) => request(app).put(`/v1/sales/clients/${id}/billing`).set(auth(world.sales)).send({ legalName: "Filmy Brands Pvt. Ltd.", gstin: "27AABCU9603R1ZX", tan });
    const ok = await save(world.c.filmy, "mumf12345a");
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.tan).toBe("MUMF12345A");
    const bad = await save(world.c.filmy, "MUMF1234");
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain("A TAN is 4 letters, 5 digits and a letter");
    const other = await request(app).put(`/v1/sales/clients/${world.c.moon}/billing`).set(auth(world.sales)).send({ legalName: "Moonlight Studios", tan: "MUMF12345A" });
    expect([other.status, other.body.error.code]).toEqual([409, "TAN_TAKEN"]);
    const inv = await a.issue(world.c.filmy, { day: TODAY, price: R(1000) });
    const full = await prisma.salesInvoice.findUnique({ where: { id: inv.id } });
    expect(Object.keys(full!.buyerSnapshot as object)).not.toContain("tan");
    expect((await save(world.c.filmy, null)).body.data.tan).toBeNull();
  });

  it("R-10 chase CSV: BOM, preamble, header, 3 chase rows, formula guard, download headers", async () => {
    await seedTdsBooks(a, world.c);
    await a.upload("/sales/reconcile/tds/uploads", Buffer.from(SAMPLE_26AS), "26as.txt", { fy: "2025-26" });
    for (const [tan, id] of [["DELH55555E", world.c.hunch], ["DELR77777Z", world.c.red]]) await request(app).put(`/v1/sales/reconcile/tds/deductors/${tan}`).set(auth(world.sales)).send({ kind: "client", clientId: id });
    await request(app).put("/v1/sales/reconcile/tds/deductors/MUMH03189E").set(auth(world.sales)).send({ kind: "non_sales", label: "Bank interest — HDFC FD" });
    await prisma.client.update({ where: { id: world.c.moon }, data: { companyName: "=CMD()" } });
    const r = await a.get("/sales/reconcile/tds/chase.csv?fy=2025-26").buffer(true).parse((res, cb) => { const ch: Buffer[] = []; res.on("data", (d: Buffer) => ch.push(d)); res.on("end", () => cb(null, Buffer.concat(ch))); });
    expect(r.status).toBe(200);
    expect(r.headers["content-disposition"]).toBe('attachment; filename="tds-chase-dspl-2025-26.csv"');
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    const buf = r.body as Buffer;
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = buf.toString("utf8").slice(1).split("\r\n").filter(Boolean);
    expect(lines[0]).toBe("Company,Digital Sukoon Private Limited");
    expect(lines[1]).toMatch(/^Source,26as\.txt · sha256 [0-9a-f]{12} · as on 5 Nov 2026 · generated .* IST by /);
    expect(lines[2]).toBe("Client,Legal name,PAN,TAN,Billing email,Quarter,Problem,Our invoice,Invoice date,Our receipt,Receipt date,TDS in our books,TDS in 26AS,TDS deposited (26AS),Difference (books − 26AS),Amount to chase,26AS booking status,What to ask");
    const rows = lines.slice(3).filter((l) => !l.startsWith("Unknown deductors"));
    expect(rows).toHaveLength(3);
    expect(rows.some((l) => l.startsWith("'=CMD()"))).toBe(true);
    expect(lines.some((l) => l.startsWith("Unknown deductors,1,"))).toBe(true);
  });

  it("R-29 no Form 26AS yet: nothing chased, only the upload to-do; chase.csv refused (R→G)", async () => {
    await seedTdsBooks(a, world.c);
    const v = (await a.get("/sales/reconcile/tds?fy=2025-26")).body.data;
    expect(v.upload).toBeNull();
    expect([v.totals.chaseCount, v.totals.chasePaise, v.rows.length, v.clients.length]).toEqual([0, 0, 0, 0]);
    expect(v.totals.booksPaise).toBe(R(27180));
    expect(v.todo.map((t: { code: string }) => t.code)).toEqual(["upload"]);
    const csv = await a.get("/sales/reconcile/tds/chase.csv?fy=2025-26");
    expect([csv.status, csv.body.error.code]).toEqual([409, "NO_26AS"]);
  });

  it("R-25 a second parse while one is held → 429 RECON_BUSY", async () => {
    let release!: () => void;
    const held = withParseSlot(() => new Promise<void>((r) => { release = r; }));
    const r = await a.upload("/sales/reconcile/tds/uploads", Buffer.from(SAMPLE_26AS), "26as.txt", { fy: "2025-26" });
    expect([r.status, r.body.error.code]).toEqual([429, "RECON_BUSY"]);
    release();
    await held;
  });
});

// ─── GST ─────────────────────────────────────────────────────────────────────────────────────

describe("reconcile — GST · GSTR-1", () => {
  let world: World;
  const a = api(() => world);
  beforeEach(async () => { world = await seedWorld(); });

  async function seedOctober() {
    const c = world.c;
    await a.issue(c.filmy, { day: "2026-09-30", price: R(20000), number: "INV/26-27/0014" });
    await a.issue(c.filmy, { day: "2026-10-14", price: R(100000), number: "INV/26-27/0016" });
    const i17 = await a.issue(c.kanara, { day: "2026-10-22", price: R(200000), number: "INV/26-27/0017" });
    await a.issue(c.filmy, { day: "2026-10-28", price: R(50000), number: "INV/26-27/0018" });
    await a.issue(c.kanara, { day: "2026-10-31", price: R(30000), number: "INV/26-27/0019" });
    const i22 = await a.issue(c.orbit, { day: "2026-10-26", price: R(5000), number: "INV/26-27/0022" });
    expect((await a.post(`/sales/invoices/${i22.id}/cancel`, { reason: "client cancelled" })).status).toBe(200);
    const g = await a.issue(c.hunch, { day: "2026-10-12", price: R(10000), number: "INV/26-27/061" });
    expect((await prisma.salesInvoice.findUnique({ where: { id: g.id } }))!.sellerSnapshot).toMatchObject({ gstin: GURUGRAM });
    const cn = await a.post("/sales/credit-notes", { invoiceId: i17.id, reason: "Post not delivered", taxablePaise: R(20000), issueDate: "2026-10-30" });
    expect(cn.status, JSON.stringify(cn.body)).toBe(201);
    return { cnNumber: cn.body.data.number as string };
  }

  it("R-11 / R-15 the October JSON reproduces G-1 from issued documents; refusals; duplicate; differences CSV", async () => {
    const { cnNumber } = await seedOctober();
    const j = gstr1OctoberJson();
    j.cdnr[0].nt[0].nt_num = cnNumber;
    const json = Buffer.from(JSON.stringify(j));
    const up = await a.upload("/sales/reconcile/gst/uploads", json, "gstr1-oct.json", { gstin: MUMBAI, period: "2026-10" });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect((await a.upload("/sales/reconcile/gst/uploads", json, "gstr1-oct.json", { gstin: MUMBAI, period: "2026-10" })).body.data.duplicate).toBe(true);
    const wrongG = await a.upload("/sales/reconcile/gst/uploads", json, "x.json", { gstin: GURUGRAM, period: "2026-10" });
    expect(wrongG.body.error).toMatchObject({ code: "GST_WRONG_GSTIN", message: "This GSTR-1 is for 27AAKCD3352K1ZF (Mumbai) — choose that registration above." });
    const nov = { ...gstr1OctoberJson(), fp: "112026" };
    expect((await a.upload("/sales/reconcile/gst/uploads", Buffer.from(JSON.stringify(nov)), "x.json", { gstin: MUMBAI, period: "2026-10" })).body.error.code).toBe("GST_WRONG_PERIOD");
    const q3 = { ...gstr1OctoberJson(), fp: "122026" };
    expect((await a.upload("/sales/reconcile/gst/uploads", Buffer.from(JSON.stringify(q3)), "q3.json", { gstin: MUMBAI, period: "2026-27-Q3" })).status).toBe(201);
    expect((await a.upload("/sales/reconcile/gst/uploads", json, "x.json", { gstin: "27AAJCD7425L1Z8", period: "2026-10" })).body.error.code).toBe("UNKNOWN_REGISTRATION");
    expect((await a.upload("/sales/reconcile/gst/uploads", json, "x.json", { period: "2026-10" })).body.error.code).toBe("PICK_REGISTRATION");

    const v = (await a.get(`/sales/reconcile/gst?gstin=${MUMBAI}&period=2026-10`)).body.data;
    const st = (n: string) => v.rows.find((r: { books: { number: string } | null; filed: { number: string } | null }) => r.books?.number === n || r.filed?.number === n)?.status;
    expect([st("INV/26-27/0016"), st("INV/26-27/0017"), st("INV/26-27/0018"), st("INV/26-27/0014"), st("INV/26-27/0022"), st("DSPL/26-27/0155"), st("INV/26-27/061"), st(cnNumber), st("INV/26-27/0019")])
      .toEqual(["matched_note", "wrong_recipient", "value_mismatch", "wrong_period", "cancelled_but_filed", "not_in_books", "not_in_books", "matched", "not_filed"]);
    expect(v.rows.find((r: { filed: { number: string } | null }) => r.filed?.number === "INV/26-27/061").hint.text).toBe("Issued from Gurugram (06AAKCD3352K1ZJ) — filed under the wrong registration.");
    expect(v.registrations.map((r: { label: string }) => r.label)).toEqual(["Mumbai", "Gurugram"]);

    const csv = await a.get(`/sales/reconcile/gst/differences.csv?gstin=${MUMBAI}&period=2026-10`);
    expect(csv.status).toBe(200);
    const lines = csv.text.replace(/^﻿/, "").split("\r\n").filter(Boolean);
    expect(lines[2].startsWith("Section,Status,Number (portal),Number (GSTR-1)")).toBe(true);
    expect(lines.slice(3).filter((l) => !l.includes(",section_total,"))).toHaveLength(7);
  });

  it("R-15 round trip: Accounts' b2b + cdnr CSVs match every invoice and note with no difference", async () => {
    const { cnNumber } = await seedOctober();
    const b2b = await buildGstCsv("dspl", "2026-10", "b2b", MUMBAI);
    const cdnr = await buildGstCsv("dspl", "2026-10", "cdnr", MUMBAI);
    expect((await a.upload("/sales/reconcile/gst/uploads", b2b.body, b2b.filename, { gstin: MUMBAI, period: "2026-10" })).status).toBe(201);
    expect((await a.upload("/sales/reconcile/gst/uploads", cdnr.body, cdnr.filename, { gstin: MUMBAI, period: "2026-10" })).status).toBe(201);
    const v = (await a.get(`/sales/reconcile/gst?gstin=${MUMBAI}&period=2026-10`)).body.data;
    const byNumber = Object.fromEntries(v.rows.map((r: { books: { number: string } | null; status: string; issues: unknown[] }) => [r.books?.number, [r.status, r.issues.length]]));
    for (const n of ["INV/26-27/0016", "INV/26-27/0017", "INV/26-27/0018", "INV/26-27/0019", cnNumber]) expect(byNumber[n], n).toEqual(["matched", 0]);
    expect(v.counts.cancelledNotFiled).toBe(1);
  });

  it("R-30 no GSTR-1 yet: nothing 'not filed', no section differences; a late credit note (s.34(2)) is never 'not filed' (R→G)", async () => {
    const { cnNumber } = await seedOctober();
    const v0 = (await a.get(`/sales/reconcile/gst?gstin=${MUMBAI}&period=2026-10`)).body.data;
    expect(v0.counts.not_filed).toBe(0);
    expect(v0.todo.map((t: { code: string }) => t.code)).toEqual(["upload"]);
    for (const k of ["b2b", "sez", "cdnr"]) expect(v0.sections.find((x: { section: string }) => x.section === k), k).toMatchObject({ filed: null, differs: false });

    const old = await a.issue(world.c.kanara, { day: "2025-03-10", price: R(10000) });
    const late = await a.post("/sales/credit-notes", { invoiceId: old.id, reason: "Late correction", taxablePaise: R(1000), issueDate: "2026-10-15" });
    expect(late.status, JSON.stringify(late.body)).toBe(201);
    // Accounts' b2b + cdnr files: the cdnr file leaves the late note out.
    const b2b = await buildGstCsv("dspl", "2026-10", "b2b", MUMBAI);
    const cdnr = await buildGstCsv("dspl", "2026-10", "cdnr", MUMBAI);
    expect(cdnr.body.toString("utf8")).not.toContain(late.body.data.number);
    await a.upload("/sales/reconcile/gst/uploads", b2b.body, "b2b.csv", { gstin: MUMBAI, period: "2026-10" });
    // only b2b stated: credit notes are not judged yet
    const v1 = (await a.get(`/sales/reconcile/gst?gstin=${MUMBAI}&period=2026-10`)).body.data;
    expect(v1.rows.some((r: { section: string }) => r.section === "cdnr")).toBe(false);
    expect(v1.sections.find((x: { section: string }) => x.section === "cdnr")).toMatchObject({ filed: null, differs: false });
    await a.upload("/sales/reconcile/gst/uploads", cdnr.body, "cdnr.csv", { gstin: MUMBAI, period: "2026-10" });
    const v = (await a.get(`/sales/reconcile/gst?gstin=${MUMBAI}&period=2026-10`)).body.data;
    expect(v.rows.some((r: { books: { number: string } | null }) => r.books?.number === late.body.data.number)).toBe(false);
    expect(v.rows.find((r: { books: { number: string } | null }) => r.books?.number === cnNumber).status).toBe("matched");
    expect([v.counts.not_filed, v.counts.lateCreditNotes]).toEqual([0, 1]);
    expect(v.sections.find((x: { section: string }) => x.section === "cdnr").differs).toBe(false);
    expect(v.todo.map((t: { code: string }) => t.code)).toEqual([]);
  });

  it("R-12 per-section currency: b2b and cdnr CSVs both current; a later JSON current for all six; b2b again → current for b2b only", async () => {
    await seedOctober();
    const b2b = await buildGstCsv("dspl", "2026-10", "b2b", MUMBAI);
    const cdnr = await buildGstCsv("dspl", "2026-10", "cdnr", MUMBAI);
    await a.upload("/sales/reconcile/gst/uploads", b2b.body, "b2b.csv", { gstin: MUMBAI, period: "2026-10" });
    await a.upload("/sales/reconcile/gst/uploads", cdnr.body, "cdnr.csv", { gstin: MUMBAI, period: "2026-10" });
    let v = (await a.get(`/sales/reconcile/gst?gstin=${MUMBAI}&period=2026-10`)).body.data;
    expect(v.uploads.map((u: { fileName: string; current: string[] }) => `${u.fileName}:${u.current.join("+")}`).sort()).toEqual(["b2b.csv:b2b", "cdnr.csv:cdnr"]);
    await a.upload("/sales/reconcile/gst/uploads", Buffer.from(JSON.stringify(gstr1OctoberJson())), "oct.json", { gstin: MUMBAI, period: "2026-10" });
    v = (await a.get(`/sales/reconcile/gst?gstin=${MUMBAI}&period=2026-10`)).body.data;
    expect(v.uploads.find((u: { fileName: string }) => u.fileName === "oct.json").current.sort()).toEqual(["b2b", "b2cl", "b2cs", "cdnr", "cdnur", "exp"]);
    const again = await a.upload("/sales/reconcile/gst/uploads", b2b.body, "b2b.csv", { gstin: MUMBAI, period: "2026-10" });
    expect(again.body.data).toMatchObject({ duplicate: true, madeCurrent: true });
    v = (await a.get(`/sales/reconcile/gst?gstin=${MUMBAI}&period=2026-10`)).body.data;
    expect(v.uploads.find((u: { fileName: string }) => u.fileName === "b2b.csv").current).toEqual(["b2b"]);
    expect(v.uploads.find((u: { fileName: string }) => u.fileName === "oct.json").current).not.toContain("b2b");
  });
});

// ─── Client balances ─────────────────────────────────────────────────────────────────────────

describe("reconcile — client balances", () => {
  let world: World;
  const a = api(() => world);
  beforeEach(async () => { world = await seedWorld(); process.env.SALES_RECONCILE_SEND_GAP_MS = "0"; });
  afterEach(() => { delete process.env.SALES_RECONCILE_ENABLED; delete process.env.SALES_RECONCILE_SEND_GAP_MS; });

  async function filmyLedgerDocs() {
    const old = await a.issue(world.c.filmy, { day: "2026-03-20", price: R(20000) });
    await a.pay(world.c.filmy, { amount: old.totalPaise, day: "2026-04-10", allocs: [{ invoiceId: old.id, amountPaise: old.totalPaise }] });
    const i10 = await a.issue(world.c.filmy, { day: "2026-09-20", price: R(100000) });
    await a.pay(world.c.filmy, { amount: R(108000), tds: R(10000), day: "2026-10-03", allocs: [{ invoiceId: i10.id, amountPaise: R(108000), tdsPaise: R(10000) }] });
    const i16 = await a.issue(world.c.filmy, { day: "2026-10-14", price: R(100000) });
    expect((await a.post("/sales/credit-notes", { invoiceId: i16.id, reason: "Post not delivered", taxablePaise: R(10000), issueDate: "2026-10-30" })).status).toBe(201);
    await a.pay(world.c.filmy, { amount: R(50000), day: "2026-10-31" });
  }
  const confs = () => sent.filter((s) => s.subject.startsWith("Balance confirmation"));

  it("R-14 the list balance equals the ledger closing for every client, and the identity holds (R→G)", async () => {
    await filmyLedgerDocs();
    const k = await a.issue(world.c.kanara, { day: "2026-08-01", price: R(5000) });
    await a.pay(world.c.kanara, { amount: R(10000), day: "2026-08-10", allocs: [{ invoiceId: k.id, amountPaise: k.totalPaise }] });
    const list = (await a.get(`/sales/reconcile/confirmations?asOf=${TODAY}&from=2026-04-01`)).body.data;
    expect(list.rows.length).toBeGreaterThanOrEqual(2);
    for (const r of list.rows) {
      const l = (await a.get(`/sales/reconcile/ledger?clientId=${r.clientId}&from=2026-04-01&to=${TODAY}`)).body.data.ledger;
      expect(l.closingPaise, r.name).toBe(r.balancePaise);
      expect(l.checks.identityOk, r.name).toBe(true);
    }
    expect(list.rows.find((r: { clientId: string }) => r.clientId === world.c.filmy).balancePaise).toBe(R(56200));
  });

  it("R-16 / R-17 create with send; existing is not re-sent; route 15 sends again; failures and no email", async () => {
    await filmyLedgerDocs();
    const body = { companyKey: "dspl", clientId: world.c.filmy, asOf: "2026-10-31", from: "2026-04-01", send: true };
    const r1 = await a.post("/sales/reconcile/confirmations", body);
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect(confs()).toHaveLength(1);
    const m = confs()[0];
    expect(m.to).toBe("accounts@filmy.test, filmybrands@c.test");
    expect(m.cc).toBe("accounts@ds.test, finance@ds.test");
    expect(m.subject).toBe("Balance confirmation as on 31 Oct 2026 — Digital Sukoon Private Limited");
    expect(m.attachments![0].content.subarray(0, 4).toString()).toBe("%PDF");
    expect(r1.body.data.confirmation).toMatchObject({ sentCount: 1, ourBalancePaise: R(56200), status: "pending" });
    const ev = await prisma.salesEvent.findFirst({ where: { entityType: "confirmation", action: "sent" } });
    expect(ev!.note).toMatch(/pdf sha256 [0-9a-f]{12}/);
    const r2 = await a.post("/sales/reconcile/confirmations", body);
    expect(r2.status).toBe(200);
    expect(confs()).toHaveLength(1);
    const r3 = await a.post(`/sales/reconcile/confirmations/${r1.body.data.confirmation.id}/send`, {});
    expect(r3.status).toBe(200);
    expect(r3.body.data.confirmation.sentCount).toBe(2);
    expect(confs()).toHaveLength(2);

    emailMode = "fail";
    const r4 = await a.post(`/sales/reconcile/confirmations/${r1.body.data.confirmation.id}/send`, {});
    expect([r4.status, r4.body.error.code]).toEqual([502, "CONFIRM_SEND_FAILED"]);
    const row = await prisma.salesBalanceConfirmation.findUnique({ where: { id: r1.body.data.confirmation.id } });
    expect([row!.sentCount, row!.lastSendError]).toEqual([2, "The email could not be sent"]);
    expect(await prisma.salesEvent.count({ where: { entityType: "confirmation", action: "send_failed" } })).toBe(1);
    emailMode = "ok";

    const k = await a.issue(world.c.kanara, { day: "2026-10-01", price: R(1000) });
    await prisma.client.update({ where: { id: world.c.kanara }, data: { email: "" } });
    const noMail = await a.post("/sales/reconcile/confirmations", { companyKey: "dspl", clientId: world.c.kanara, asOf: "2026-10-31", from: "2026-04-01", send: true });
    expect([noMail.status, noMail.body.error.code]).toEqual([409, "CONFIRM_NO_EMAIL"]);
    void k;
    const quiet = await a.post("/sales/reconcile/confirmations", { companyKey: "dspl", clientId: world.c.moon, asOf: "2026-10-31", from: "2026-04-01" });
    expect([quiet.status, quiet.body.error.code]).toEqual([409, "CONFIRM_NOTHING"]);
  });

  it("R-31 a sent statement is never re-frozen without resending; a failed first send is retried by route 10 (R→G)", async () => {
    await filmyLedgerDocs();
    const body = { companyKey: "dspl", clientId: world.c.filmy, asOf: "2026-10-31", from: "2026-04-01" };
    emailMode = "fail";
    const f1 = await a.post("/sales/reconcile/confirmations", { ...body, send: true });
    expect([f1.status, f1.body.error.code]).toEqual([502, "CONFIRM_SEND_FAILED"]);
    emailMode = "ok";
    const r2 = await a.post("/sales/reconcile/confirmations", { ...body, send: true });
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(r2.body.data.email).toMatchObject({ sent: true });
    expect(confs()).toHaveLength(1);
    const id = r2.body.data.confirmation.id;

    await a.pay(world.c.filmy, { amount: R(10000), day: "2026-10-31" });
    const before = (await prisma.salesBalanceConfirmation.findUnique({ where: { id } }))!;
    const refreshOnly = await a.post("/sales/reconcile/confirmations", { ...body, refresh: true });
    expect([refreshOnly.status, refreshOnly.body.error.code]).toEqual([409, "CONFIRM_ALREADY_SENT"]);
    const after = (await prisma.salesBalanceConfirmation.findUnique({ where: { id } }))!;
    expect([after.ledgerSha256, after.ourBalancePaise]).toEqual([before.ledgerSha256, before.ourBalancePaise]);
    // refresh + send together: allowed, and the replaced ledger stays in the event
    const both = await a.post("/sales/reconcile/confirmations", { ...body, refresh: true, send: true });
    expect(both.status, JSON.stringify(both.body)).toBe(200);
    expect(both.body.data.confirmation.ourBalancePaise).toBe(R(46200));
    expect(confs()).toHaveLength(2);
    const ev = await prisma.salesEvent.findFirst({ where: { entityType: "confirmation", entityId: id, action: "refreshed" } });
    expect(ev!.note).toContain(`was ₹56,200.00 Dr · ledger sha256 ${before.ledgerSha256.slice(0, 12)} →`);
  });

  it("R-18 batch: queued and skipped; sent in the background one after another; 26 ids refused", async () => {
    await filmyLedgerDocs();
    await a.issue(world.c.kanara, { day: "2026-10-01", price: R(1000) });
    await prisma.client.update({ where: { id: world.c.kanara }, data: { email: "" } });
    const h = await a.issue(world.c.hunch, { day: "2026-10-01", price: R(1000) });
    void h;
    const already = await a.post("/sales/reconcile/confirmations", { companyKey: "dspl", clientId: world.c.hunch, asOf: "2026-10-31", from: "2026-04-01", send: true });
    expect(already.status).toBe(201);
    emailMode = "slow";
    const r = await a.post("/sales/reconcile/confirmations/send-batch", { companyKey: "dspl", asOf: "2026-10-31", from: "2026-04-01", clientIds: [world.c.filmy, world.c.kanara, world.c.hunch] });
    expect(r.status).toBe(202);
    expect(r.body.data.queued.map((q: { clientId: string }) => q.clientId)).toEqual([world.c.filmy]);
    expect(r.body.data.skipped.map((q: { clientId: string }) => q.clientId).sort()).toEqual([world.c.hunch, world.c.kanara].sort());
    await flushSalesBackground();
    const row = await prisma.salesBalanceConfirmation.findFirst({ where: { clientId: world.c.filmy } });
    expect([row!.sentCount, row!.queuedAt]).toEqual([1, null]);
    // Two queued → never overlapping
    maxInFlight = 0;
    const r2 = await a.post("/sales/reconcile/confirmations/send-batch", { companyKey: "dspl", asOf: "2026-10-31", from: "2026-04-01", clientIds: [world.c.filmy, world.c.hunch], resend: true });
    expect(r2.body.data.queued).toHaveLength(2);
    await flushSalesBackground();
    expect(maxInFlight).toBe(1);
    const many = Array.from({ length: 26 }, () => crypto.randomUUID());
    expect((await a.post("/sales/reconcile/confirmations/send-batch", { companyKey: "dspl", asOf: "2026-10-31", from: "2026-04-01", clientIds: many })).status).toBe(400);
  });

  it("R-19 responses: a confirmed figure ₹1.01 off refused; disputed needs figure and note; difference exact; answered rows refuse refresh", async () => {
    await filmyLedgerDocs();
    const c = (await a.post("/sales/reconcile/confirmations", { companyKey: "dspl", clientId: world.c.filmy, asOf: "2026-10-31", from: "2026-04-01" })).body.data.confirmation;
    const put = (b: object) => request(app).put(`/v1/sales/reconcile/confirmations/${c.id}/response`).set(auth(world.sales)).send(b);
    const off = await put({ status: "confirmed", theirBalancePaise: R(56200) + 101 });
    expect([off.status, off.body.error.code, off.body.error.message]).toEqual([422, "CONFIRM_FIGURE_DIFFERS", "That is not our figure (₹56,200.00 Dr) — record it as Disputed."]);
    expect((await put({ status: "confirmed", theirBalancePaise: R(56200) + 100 })).status).toBe(200);
    expect((await put({ status: "disputed", note: "x y z" })).status).toBe(400);
    expect((await put({ status: "disputed", theirBalancePaise: R(46200) })).status).toBe(400);
    const d = await put({ status: "disputed", theirBalancePaise: R(46200), note: "Missing credit note" });
    expect(d.body.data.confirmation).toMatchObject({ status: "disputed", differencePaise: R(10000) });
    const refresh = await a.post("/sales/reconcile/confirmations", { companyKey: "dspl", clientId: world.c.filmy, asOf: "2026-10-31", from: "2026-04-01", refresh: true });
    expect([refresh.status, refresh.body.error.code]).toEqual([409, "CONFIRM_ANSWERED"]);
  });

  it("R-20 BIGINT: two ₹1.5 crore invoices → 3,000,000,000 paise stored and returned exactly (R→G)", async () => {
    await a.issue(world.c.red, { day: "2026-10-01", price: R(12711864.41) });
    await a.issue(world.c.red, { day: "2026-10-02", price: R(12711864.41) });
    const list = (await a.get(`/sales/reconcile/confirmations?asOf=2026-10-31&from=2026-04-01`)).body.data;
    const row = list.rows.find((r: { clientId: string }) => r.clientId === world.c.red);
    expect(row.balancePaise).toBeGreaterThan(2_147_483_647);
    const c = await a.post("/sales/reconcile/confirmations", { companyKey: "dspl", clientId: world.c.red, asOf: "2026-10-31", from: "2026-04-01" });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body.data.confirmation.ourBalancePaise).toBe(row.balancePaise);
    const db = await prisma.salesBalanceConfirmation.findFirst({ where: { clientId: world.c.red } });
    expect(Number(db!.ourBalancePaise)).toBe(row.balancePaise);
  });

  it("R-21 / R-27 company isolation and COMPANY_MISMATCH", async () => {
    await a.issue(world.c.filmy, { day: "2026-10-01", price: R(1000), company: "dmpl" });
    const d = (await a.get(`/sales/reconcile/confirmations?asOf=2026-10-31&from=2026-04-01`)).body.data;
    expect(d.rows.some((r: { clientId: string }) => r.clientId === world.c.filmy)).toBe(false);
    const l = (await a.get(`/sales/reconcile/ledger?clientId=${world.c.filmy}&from=2026-04-01&to=2026-10-31`)).body.data.ledger;
    expect(l.lines).toEqual([]);
    const dm = await a.post("/sales/reconcile/confirmations", { companyKey: "dmpl", clientId: world.c.filmy, asOf: "2026-10-31", from: "2026-04-01" });
    expect(dm.status).toBe(201);
    const mis = await a.get(`/sales/reconcile/confirmations/${dm.body.data.confirmation.id}?company=dspl`);
    expect([mis.status, mis.body.error.code, mis.body.error.message]).toEqual([409, "COMPANY_MISMATCH", "This belongs to Dashmani Media — switch company at the top."]);
    expect((await a.get(`/sales/reconcile/gst?gstin=27AAJCD7425L1Z8&period=2026-10`)).body.error.code).toBe("UNKNOWN_REGISTRATION");
  });

  it("R-22 reply file: PDF stored and returned byte for byte; PNG ok; disguised bytes refused; no data in JSON; nothing on disk", async () => {
    await filmyLedgerDocs();
    const c = (await a.post("/sales/reconcile/confirmations", { companyKey: "dspl", clientId: world.c.filmy, asOf: "2026-10-31", from: "2026-04-01" })).body.data.confirmation;
    const before = listFiles(process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads")).sort();
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(2000, 7)]);
    const up = await a.upload(`/sales/reconcile/confirmations/${c.id}/file`, pdf, "reply.pdf", {});
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const back = await a.get(`/sales/reconcile/confirmations/${c.id}/file`).buffer(true).parse((res, cb) => { const ch: Buffer[] = []; res.on("data", (x: Buffer) => ch.push(x)); res.on("end", () => cb(null, Buffer.concat(ch))); });
    expect(Buffer.compare(back.body as Buffer, pdf)).toBe(0);
    expect(back.headers["x-content-type-options"]).toBe("nosniff");
    expect((await a.upload(`/sales/reconcile/confirmations/${c.id}/file`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]), "reply.png", {})).status).toBe(201);
    const mz = await a.upload(`/sales/reconcile/confirmations/${c.id}/file`, Buffer.from("MZ\x90\x00"), "reply.pdf", {});
    expect([mz.status, mz.body.error.code]).toEqual([415, "REPLY_FILE_TYPE"]);
    const list = await a.get(`/sales/reconcile/confirmations?asOf=2026-10-31&from=2026-04-01`);
    const ledger = await a.get(`/sales/reconcile/ledger?clientId=${world.c.filmy}&from=2026-04-01&to=2026-10-31`);
    for (const r of [list, ledger]) { expect(r.text).not.toContain('"data":{"type"'); expect(r.text.length).toBeLessThan(100_000); expect(JSON.stringify(r.body.data)).not.toContain('"data":'); }
    expect(listFiles(process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads")).sort()).toEqual(before);
    expect((await request(app).delete(`/v1/sales/reconcile/confirmations/${c.id}/file`).set(auth(world.sales))).body.data.confirmation.hasFile).toBe(false);
  });

  it("R-23 stale after a backdated invoice; send with refresh re-freezes", async () => {
    await filmyLedgerDocs();
    const c = (await a.post("/sales/reconcile/confirmations", { companyKey: "dspl", clientId: world.c.filmy, asOf: "2026-10-31", from: "2026-04-01", send: true })).body.data.confirmation;
    await a.issue(world.c.filmy, { day: "2026-10-20", price: R(1000) });
    const one = (await a.get(`/sales/reconcile/confirmations/${c.id}`)).body.data;
    expect(one.stale).toBe(true);
    const sha1 = (await prisma.salesBalanceConfirmation.findUnique({ where: { id: c.id } }))!.ledgerSha256;
    const s = await a.post(`/sales/reconcile/confirmations/${c.id}/send`, { refresh: true });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const row = await prisma.salesBalanceConfirmation.findUnique({ where: { id: c.id } });
    expect(row!.ledgerSha256).not.toBe(sha1);
    expect(Number(row!.ourBalancePaise)).toBe(R(56200 + 1180));
    expect(s.body.data.confirmation.stale).toBe(false);
  });

  it("R-24 kill switch: uploads, sends, batch and reply files 503; reads, TAN mapping and responses still work", async () => {
    await filmyLedgerDocs();
    const c = (await a.post("/sales/reconcile/confirmations", { companyKey: "dspl", clientId: world.c.filmy, asOf: "2026-10-31", from: "2026-04-01" })).body.data.confirmation;
    process.env.SALES_RECONCILE_ENABLED = "0";
    const off = [
      await a.upload("/sales/reconcile/tds/uploads", Buffer.from(SAMPLE_26AS), "26as.txt", { fy: "2025-26" }),
      await a.upload("/sales/reconcile/gst/uploads", Buffer.from("{}"), "x.json", { gstin: MUMBAI, period: "2026-10" }),
      await a.post("/sales/reconcile/confirmations", { companyKey: "dspl", clientId: world.c.filmy, asOf: "2026-10-30", from: "2026-04-01" }),
      await a.post(`/sales/reconcile/confirmations/${c.id}/send`, {}),
      await a.post("/sales/reconcile/confirmations/send-batch", { companyKey: "dspl", asOf: "2026-10-31", from: "2026-04-01", clientIds: [world.c.filmy] }),
      await a.upload(`/sales/reconcile/confirmations/${c.id}/file`, Buffer.from("%PDF-1"), "r.pdf", {}),
    ];
    for (const r of off) expect([r.status, r.body.error.code]).toEqual([503, "RECONCILE_OFF"]);
    expect((await a.get("/sales/reconcile/tds?fy=2025-26")).status).toBe(200);
    expect((await request(app).put("/v1/sales/reconcile/tds/deductors/MUMF12345A").set(auth(world.sales)).send({ kind: "client", clientId: world.c.filmy })).status).toBe(200);
    expect((await request(app).put(`/v1/sales/reconcile/confirmations/${c.id}/response`).set(auth(world.sales)).send({ status: "confirmed" })).status).toBe(200);
  });

  it("R-26 events of the five new types are readable; the dashboard feed hides them and tan_learned", async () => {
    await logEvents();
    for (const t of ["tds_upload", "gst_upload", "tds_deductor", "confirmation", "brs_month"]) expect((await a.get(`/sales/events?entityType=${t}&entityId=x`)).status, t).toBe(200);
    const dash = (await a.get("/sales/dashboard")).body.data;
    const feed = JSON.stringify(dash.recent ?? dash.activity ?? dash);
    expect(feed).not.toContain("tan_learned");
    expect(feed).not.toContain("made_current");
    async function logEvents() {
      for (const [entityType, action] of [["tds_upload", "made_current"], ["gst_upload", "uploaded"], ["tds_deductor", "mapped"], ["confirmation", "created"], ["brs_month", "reconciled"], ["client", "tan_learned"]]) {
        await prisma.salesEvent.create({ data: { entityType, entityId: "x", action } });
      }
    }
  });

  it("R-28 dates: as-of tomorrow, more than three FYs, a bad FY or period", async () => {
    const tomorrow = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    expect((await a.get(`/sales/reconcile/confirmations?asOf=${tomorrow}&from=2026-04-01`)).body.error.code).toBe("AS_OF_IN_FUTURE");
    expect((await a.get(`/sales/reconcile/ledger?clientId=${world.c.filmy}&from=2022-04-01&to=${TODAY}`)).body.error.code).toBe("RANGE_TOO_LONG");
    expect((await a.get("/sales/reconcile/tds?fy=2025-27")).body.error.code).toBe("BAD_FY");
    expect((await a.get("/sales/reconcile/gst?period=2026-27")).body.error.code).toBe("BAD_PERIOD");
  });
});

// ─── Read-only to money (I1) ─────────────────────────────────────────────────────────────────

describe("reconcile — never writes a money table", () => {
  let world: World;
  const a = api(() => world);
  beforeEach(async () => { world = await seedWorld(); process.env.SALES_RECONCILE_SEND_GAP_MS = "0"; });
  afterEach(() => { delete process.env.SALES_RECONCILE_SEND_GAP_MS; });

  it("R-13 counts and max timestamps of every money table are unchanged around every reconcile route", async () => {
    await seedTdsBooks(a, world.c);
    await flushSalesBackground();
    const snap = await moneySnapshot();
    const steps: Array<() => Promise<{ status: number }>> = [
      () => a.upload("/sales/reconcile/tds/uploads", Buffer.from(SAMPLE_26AS), "26as.txt", { fy: "2025-26" }),
      () => a.get("/sales/reconcile/tds?fy=2025-26"),
      () => a.get("/sales/reconcile/tds/chase.csv?fy=2025-26"),
      () => request(app).put("/v1/sales/reconcile/tds/deductors/DELH55555E").set(auth(world.sales)).send({ kind: "client", clientId: world.c.hunch }),
      () => request(app).put("/v1/sales/reconcile/tds/deductors/MUMS11111B").set(auth(world.sales)).send({ kind: "non_sales", label: "Star Group rent" }),
      () => request(app).delete("/v1/sales/reconcile/tds/deductors/MUMS11111B").set(auth(world.sales)),
      () => a.upload("/sales/reconcile/gst/uploads", Buffer.from(JSON.stringify(gstr1OctoberJson())), "oct.json", { gstin: MUMBAI, period: "2026-10" }),
      () => a.get(`/sales/reconcile/gst?gstin=${MUMBAI}&period=2026-10`),
      () => a.get(`/sales/reconcile/gst/differences.csv?gstin=${MUMBAI}&period=2026-10`),
      () => a.get(`/sales/reconcile/confirmations?asOf=2026-03-31&from=2025-04-01`),
      () => a.post("/sales/reconcile/confirmations", { companyKey: "dspl", clientId: world.c.filmy, asOf: "2026-03-31", from: "2025-04-01", send: true }),
      () => a.post("/sales/reconcile/confirmations/send-batch", { companyKey: "dspl", asOf: "2026-03-31", from: "2025-04-01", clientIds: [world.c.kanara], resend: true }),
      () => a.get(`/sales/reconcile/ledger?clientId=${world.c.filmy}&from=2025-04-01&to=2026-03-31`),
      () => a.get(`/sales/reconcile/ledger.pdf?clientId=${world.c.filmy}&from=2025-04-01&to=2026-03-31`),
    ];
    for (const s of steps) {
      const r = await s();
      expect(r.status, `${s.toString().slice(6, 90)} ${JSON.stringify((r as { body?: unknown }).body ?? "").slice(0, 300)}`).toBeLessThan(300);
      await flushSalesBackground();
      expect(await moneySnapshot()).toEqual(snap);
    }
    const c = await prisma.salesBalanceConfirmation.findFirst({ where: { clientId: world.c.filmy } });
    for (const s of [
      () => request(app).put(`/v1/sales/reconcile/confirmations/${c!.id}/response`).set(auth(world.sales)).send({ status: "disputed", theirBalancePaise: 1, note: "differs" }),
      () => a.upload(`/sales/reconcile/confirmations/${c!.id}/file`, Buffer.from("%PDF-1.4"), "r.pdf", {}),
      () => a.get(`/sales/reconcile/confirmations/${c!.id}/pdf`),
    ]) {
      expect((await s()).status).toBeLessThan(300);
      expect(await moneySnapshot()).toEqual(snap);
    }
  });
});
