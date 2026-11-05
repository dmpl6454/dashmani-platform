/**
 * Bank statements, matching and TDS — routes + DB (spec-bank §8.3). Seeding happens inside each
 * describe (vitest 1.x runs same-level hooks in parallel). Statements are built in the test as
 * CSV / XLSX buffers — no binary fixtures. (R→G) cases were proven by breaking the rule once.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import request from "supertest";
import * as XLSX from "xlsx";
import { prisma } from "@dashmani/db";
import { todayIST } from "@dashmani/shared";

const sent: Array<{ to: string; subject: string }> = [];
vi.mock("../src/services/email.service", async (orig) => {
  const real = await orig<typeof import("../src/services/email.service")>();
  return { ...real, sendEmail: vi.fn(async (o: { to: string; subject: string }) => { sent.push(o); return { messageId: "test" }; }) };
});

import app from "../src/app";
import { flushSalesBackground } from "../src/services/sales/common";
import { setBankLinePageSizeForTests } from "../src/services/sales/bank.service";
import { createTestRole, createTestUser, generateToken } from "./helpers";

const SELLER = {
  legalName: "Digital Sukoon Private Limited", gstin: "27AAKCD3352K1ZF", pan: "AAKCD3352K", addressLine1: "702 Parinee I, Andheri West", city: "Mumbai",
  state: "Maharashtra", stateCode: "27", pincode: "400053", invoicePrefix: "INV", creditNotePrefix: "CN", receiptPrefix: "RCPT", defaultDueDays: 15, roundToRupee: true,
  email: "accounts@ds.test", autoEmailInvoices: true,
};
const ACC = "88452818788";
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const today = todayIST();
const d = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dmy = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
const rupees = (paise: number) => (paise / 100).toFixed(2);
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");
const narr = (utr: string, who = "FILMY BRANDS PVT LTD") => `NEFT CR-HDFC0000240-${who}-DIGITAL SUKOON PRIVATE LIMITED-${utr}`;

type Row = { date: string; narr: string; ref?: string; dr?: number; cr?: number };
/** A statement in the IDFC layout, account number in the preamble, running balance consistent. */
function statement(rows: Row[], o: { opening?: number; balance?: boolean; account?: string } = {}): Buffer {
  let bal = o.opening ?? 100_000_000;
  const withBal = o.balance !== false;
  const out: string[][] = [[`Account No : ${o.account ?? ACC}`], [], ["Transaction Date", "Particulars", "Cheque No", "Debit", "Credit", ...(withBal ? ["Balance"] : [])]];
  for (const r of rows) {
    bal += (r.cr ?? 0) - (r.dr ?? 0);
    out.push([dmy(r.date), r.narr, r.ref ?? "", r.dr ? rupees(r.dr) : "", r.cr ? rupees(r.cr) : "", ...(withBal ? [rupees(bal)] : [])]);
  }
  return Buffer.from(out.map((r) => r.map((c) => (/[",]/.test(c) ? `"${c}"` : c)).join(",")).join("\r\n"));
}

describe("bank statements, matching and TDS", () => {
  let sales: string;
  let adminT: string;
  let empT: string;
  let filmy: string;
  let zenith: string;
  let accountId: string;

  beforeEach(async () => {
    sent.length = 0;
    await prisma.systemSetting.deleteMany({ where: { key: { startsWith: "sales.seller" } } });
    await createTestRole("Sales", ["view", "manage"].map((action) => ({ resource: "sales", action, scope: "global" })));
    await createTestRole("Admin", ["view", "manage", "approve"].map((action) => ({ resource: "sales", action, scope: "global" })));
    await createTestRole("Employee", [{ resource: "tasks", action: "view", scope: "own" }]);
    const mk = async (name: string, role: string) => { const u = await createTestUser({ name, roleNames: [role] }); return generateToken(u.id, u.email, [role]); };
    sales = await mk("Seller", "Sales");
    adminT = await mk("Boss", "Admin");
    empT = await mk("Emp", "Employee");
    expect((await request(app).put("/v1/sales/settings/seller").set(auth(adminT)).send(SELLER)).status).toBe(200);
    const f = await prisma.client.create({ data: { companyName: "Filmy Brands", contactName: "Riya", email: "riya@filmy.test", passwordHash: "x" } });
    await prisma.clientBillingProfile.create({ data: { clientId: f.id, legalName: "Filmy Brands Private Limited", gstin: "27AABCU9603R1ZX", stateCode: "27", state: "Maharashtra", city: "Mumbai", billingEmail: "bills@filmy.test" } });
    const z = await prisma.client.create({ data: { companyName: "Zenith Retail", contactName: "Zed", email: "zed@zenith.test", passwordHash: "x" } });
    await prisma.clientBillingProfile.create({ data: { clientId: z.id, legalName: "Zenith Retail LLP", stateCode: "27", state: "Maharashtra", city: "Mumbai" } });
    filmy = f.id;
    zenith = z.id;
    const a = await request(app).post("/v1/sales/bank/accounts").set(auth(adminT)).send({ companyKey: "dspl", label: "IDFC First current", bank: "idfc", accountNumber: ACC, ifsc: "IDFB0040178" });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body.data).toMatchObject({ last4: "8788", matchFrom: "2023-04-01", status: "active" });
    accountId = a.body.data.id;
  });

  const api = () => request(app);
  async function issued(clientId = filmy, unit = 10_000_000, issueDate = d(-10), company = "dspl") {
    const dr = await api().post(`/v1/sales/invoices?company=${company}`).set(auth(sales)).send({ clientId, companyKey: company, items: [{ description: "Reel", quantity: 1, unitPricePaise: unit }] });
    expect(dr.status, JSON.stringify(dr.body)).toBe(201);
    const i = await api().post(`/v1/sales/invoices/${dr.body.data.id}/issue`).set(auth(sales)).send({ issueDate });
    expect(i.status, JSON.stringify(i.body)).toBe(200);
    return i.body.data as { id: string; number: string; totalPaise: number };
  }
  const preview = (file: Buffer, name = "oct.csv", extra: Record<string, string> = {}, token = sales, company = "dspl") => {
    const r = api().post(`/v1/sales/bank/statements/preview?company=${company}`).set(auth(token)).field("bankAccountId", extra.bankAccountId ?? accountId);
    for (const [k, v] of Object.entries(extra)) if (k !== "bankAccountId") r.field(k, v);
    return r.attach("file", file, name);
  };
  async function importFile(file: Buffer, name = "oct.csv", o: { accept?: boolean; token?: string } = {}) {
    const p = await preview(file, name, {}, o.token);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    return api().post("/v1/sales/bank/statements?company=dspl").set(auth(o.token ?? sales))
      .field("bankAccountId", accountId).field("mapping", JSON.stringify(p.body.data.mapping ?? {})).field("expectedSha256", p.body.data.fileSha256)
      .field("acceptWarnings", o.accept === false ? "false" : "true").attach("file", file, name);
  }
  async function lineOf(narrStart: string, token = sales) {
    const l = await prisma.salesBankLine.findFirstOrThrow({ where: { narration: { contains: narrStart } } });
    return (await api().get(`/v1/sales/bank/lines/${l.id}`).set(auth(token))).body.data;
  }
  const confirmTop = (line: { id: string; suggestion: { candidates: Array<{ clientId: string; amountPaise: number; tdsPaise: number; tdsRateBp: number | null; tdsSection: string | null; allocations: Array<{ invoiceId: string; amountPaise: number; tdsPaise: number }> }> } }, extra: Record<string, unknown> = {}) => {
    const c = line.suggestion.candidates[0];
    return api().post(`/v1/sales/bank/lines/${line.id}/confirm`).set(auth(sales)).send({
      clientId: c.clientId, amountPaise: c.amountPaise, tdsPaise: c.tdsPaise, tdsRateBp: c.tdsRateBp, tdsSection: c.tdsSection,
      allocations: c.allocations.map((a) => ({ invoiceId: a.invoiceId, amountPaise: a.amountPaise, tdsPaise: a.tdsPaise })), ...extra,
    });
  };
  const counts = async () => [await prisma.salesBankAccount.count(), await prisma.salesBankStatement.count(), await prisma.salesBankLine.count()];
  const receiptSeq = async () => (await prisma.salesSequence.findMany({ where: { key: { startsWith: "receipt" } } })).map((s) => s.next);

  it("RBAC: employees are refused; Sales previews but cannot add accounts or delete statements; debit narrations are admin-only", async () => {
    expect((await api().get("/v1/sales/bank/lines?company=dspl").set(auth(empT))).status).toBe(403);
    expect((await api().post("/v1/sales/bank/accounts").set(auth(sales)).send({ companyKey: "dspl", label: "X bank", bank: "other", accountNumber: "123456789" })).status).toBe(403);
    const file = statement([{ date: d(-1), narr: narr("HDFCN52026110001"), cr: 500_000 }, { date: d(-1), narr: "ATM WDL SALARY RAVI", dr: 20_000 }]);
    expect((await importFile(file)).status).toBe(201);
    const s = await prisma.salesBankStatement.findFirstOrThrow();
    expect((await api().delete(`/v1/sales/bank/statements/${s.id}`).set(auth(sales)).send({ reason: "wrong file" })).status).toBe(403);
    const asSales = (await api().get("/v1/sales/bank/lines?company=dspl&tab=debits").set(auth(sales))).body.data.lines;
    expect(asSales[0]).toMatchObject({ narration: "", reference: null, utr: null, redacted: true, debitPaise: 20_000 });
    const asAdmin = (await api().get("/v1/sales/bank/lines?company=dspl&tab=debits").set(auth(adminT))).body.data.lines;
    expect(asAdmin[0].narration).toBe("ATM WDL SALARY RAVI");
    // A text search must not tell a non-admin which withdrawals mention a word — on ANY tab (R→G).
    for (const tab of ["all", "debits", "review"]) {
      expect((await api().get(`/v1/sales/bank/lines?company=dspl&tab=${tab}&q=SALARY`).set(auth(sales))).body.data.lines).toHaveLength(0);
    }
    const st = await prisma.salesBankStatement.findFirstOrThrow();
    expect((await api().get(`/v1/sales/bank/lines?company=dspl&tab=all&statementId=${st.id}&q=SALARY`).set(auth(sales))).body.data.lines).toHaveLength(0);
    expect((await api().get("/v1/sales/bank/lines?company=dspl&tab=all&q=SALARY").set(auth(adminT))).body.data.lines).toHaveLength(1);
  });

  it("an all-digit search finds a UTR/RRN as well as an amount (R→G)", async () => {
    await importFile(statement([{ date: d(-1), narr: "UPI/530912345678/PAYMENT FROM RIYA", cr: 250_000 }, { date: d(-1), narr: "NEFT CR OTHER", cr: 530_900 }]));
    const byRrn = (await api().get("/v1/sales/bank/lines?company=dspl&tab=all&q=530912345678").set(auth(sales))).body.data.lines;
    expect(byRrn.map((l: { creditPaise: number }) => l.creditPaise)).toEqual([250_000]);
    const byAmount = (await api().get("/v1/sales/bank/lines?company=dspl&tab=all&q=5309").set(auth(sales))).body.data.lines;
    expect(byAmount.map((l: { creditPaise: number }) => l.creditPaise).sort()).toEqual([250_000, 530_900]);
  });

  it("preview writes nothing and stores no file (R→G)", async () => {
    const before = await counts();
    const cwdBefore = fs.readdirSync(process.cwd()).sort();
    const upBefore = fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR, { recursive: true } as never).length : 0;
    const p = await preview(statement([{ date: d(-1), narr: narr("HDFCN52026110002"), cr: 500_000 }]));
    expect(p.status).toBe(200);
    expect(p.body.data).toMatchObject({ format: "csv", canImport: true, accountCheck: { status: "match" }, counts: { credits: 1, newLines: 1 }, preset: "idfc" });
    expect(await counts()).toEqual(before);
    expect(fs.readdirSync(process.cwd()).sort()).toEqual(cwdBefore);
    expect(fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR, { recursive: true } as never).length : 0).toBe(upBefore);
  });

  it("import stores the statement and lines; withdrawals are ignored; the event is logged", async () => {
    await issued();
    const r = await importFile(statement([{ date: d(-1), narr: narr("HDFCN52026110003"), cr: 11_800_000 }, { date: d(-1), narr: "NEFT DR VENDOR", dr: 30_000 }, { date: d(-1), narr: "NEFT CR SOMEONE UNKNOWN", cr: 77_700 }]));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({ newLines: 3, credits: 2, debits: 1, suggested: 1, sure: 1, unmatched: 1 });
    const lines = await prisma.salesBankLine.findMany({ orderBy: { rowNo: "asc" } });
    expect(lines.map((l) => [l.status, l.ignoreReason])).toEqual([["suggested", null], ["ignored", "debit"], ["unmatched", null]]);
    const ev = await prisma.salesEvent.findMany({ where: { entityType: "bank_statement" } });
    expect(ev.map((e) => e.action)).toEqual(["imported"]);
  });

  it("the same file twice → DUPLICATE_STATEMENT (R→G); the same month as XLSX → NOTHING_NEW; 1–15 then 1–31 adds only the new lines (R→G)", async () => {
    const first = [{ date: d(-20), narr: narr("HDFCN52026100001"), cr: 100_000 }, { date: d(-15), narr: "NEFT DR A", dr: 5_000 }];
    const later = [{ date: d(-5), narr: narr("HDFCN52026100002"), cr: 200_000 }];
    const half = statement(first);
    expect((await importFile(half, "1-15.csv")).status).toBe(201);
    const again = await importFile(half, "1-15.csv");
    expect([again.status, again.body.error.code]).toEqual([409, "DUPLICATE_STATEMENT"]);
    expect(await prisma.salesBankLine.count()).toBe(2);
    // Same data as an Excel download (different file, same rows and balances): nothing new.
    const rows = half.toString().split("\r\n").map((l) => l.split(","));
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Statement");
    const xl = await importFile(Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })), "1-15.xlsx");
    expect([xl.status, xl.body.error?.code]).toEqual([409, "NOTHING_NEW"]);
    const full = await importFile(statement([...first, ...later]), "1-31.csv");
    expect(full.status, JSON.stringify(full.body)).toBe(201);
    expect(full.body.data).toMatchObject({ newLines: 1, duplicates: 2 });
    expect(await prisma.salesBankLine.count()).toBe(3);
  });

  it("two overlapping imports at once never store a line twice", async () => {
    const a = statement([{ date: d(-3), narr: narr("HDFCN52026100010"), cr: 100_000 }]);
    const b = statement([{ date: d(-3), narr: narr("HDFCN52026100010"), cr: 100_000 }, { date: d(-2), narr: narr("HDFCN52026100011"), cr: 50_000 }]);
    const pa = (await preview(a, "a.csv")).body.data;
    const pb = (await preview(b, "b.csv")).body.data;
    const post = (file: Buffer, name: string, p: { mapping: unknown; fileSha256: string }) => api().post("/v1/sales/bank/statements?company=dspl").set(auth(sales))
      .field("bankAccountId", accountId).field("mapping", JSON.stringify(p.mapping)).field("expectedSha256", p.fileSha256).field("acceptWarnings", "true").attach("file", file, name);
    const res = await Promise.all([post(a, "a.csv", pa), post(b, "b.csv", pb)]);
    for (const r of res) expect([201, 409, 429]).toContain(r.status);
    const lines = await prisma.salesBankLine.findMany();
    expect(new Set(lines.map((l) => l.dedupeHash)).size).toBe(lines.length);
  });

  it("blockers and warnings: another account's statement, unreadable rows", async () => {
    const other = await importFile(statement([{ date: d(-1), narr: "X", cr: 100 }], { account: "XXXXXXX4421" }));
    expect([other.status, other.body.error.code]).toEqual([422, "STATEMENT_BLOCKED"]);
    expect(other.body.error.message).toBe("This statement is for account ending 4421, not IDFC First current ••8788");
    const bad = Buffer.concat([statement([{ date: d(-1), narr: narr("HDFCN52026100020"), cr: 100_000 }]), Buffer.from(`\r\n31/02/2026,BROKEN,,,5.00,`)]);
    const no = await importFile(bad, "bad.csv", { accept: false });
    expect([no.status, no.body.error.code]).toEqual([409, "WARNINGS_NOT_ACCEPTED"]);
    const yes = await importFile(bad, "bad.csv");
    expect(yes.status).toBe(201);
    const st = await prisma.salesBankStatement.findFirstOrThrow();
    expect((st.warnings as string[])[0]).toContain("will NOT be imported");
    expect(await prisma.salesBankLine.count()).toBe(1);
  });

  it("FILE_CHANGED, COMPANY_MISMATCH, PDF 415, 6 MB 413, a second parse at once 429", async () => {
    const file = statement([{ date: d(-1), narr: narr("HDFCN52026100030"), cr: 100_000 }]);
    const p = await preview(file);
    const changed = await api().post("/v1/sales/bank/statements?company=dspl").set(auth(sales)).field("bankAccountId", accountId)
      .field("mapping", JSON.stringify(p.body.data.mapping)).field("expectedSha256", "0".repeat(64)).attach("file", file, "oct.csv");
    expect(changed.body.error.code).toBe("FILE_CHANGED");
    const mm = await preview(file, "oct.csv", {}, sales, "dmpl");
    expect([mm.status, mm.body.error.code]).toEqual([409, "COMPANY_MISMATCH"]);
    expect(mm.body.error.message).toContain("belongs to Digital Sukoon");
    const pdf = await preview(Buffer.from("%PDF-1.7"), "oct.pdf");
    expect([pdf.status, pdf.body.error.code]).toEqual([415, "STATEMENT_PDF"]);
    const big = await preview(Buffer.alloc(6 * 1024 * 1024, 65), "big.csv");
    expect([big.status, big.body.error.code]).toEqual([413, "FILE_TOO_LARGE"]);
    const many = statement(Array.from({ length: 15_000 }, (_, i) => ({ date: d(-1), narr: `NEFT CR ${i}`, cr: 100 + i })));
    const res = await Promise.all([preview(many, "many.csv"), new Promise((r) => setTimeout(r, 15)).then(() => preview(file, "small.csv"))]);
    expect(res.map((r) => r.status).sort()).toContain(429);
    expect(res.find((r) => r.status === 429)!.body.error.code).toBe("BANK_BUSY");
  });

  it("confirm with 10% TDS records the receipt from the credit and settles the invoice", async () => {
    const inv = await issued();
    expect((await importFile(statement([{ date: d(-1), narr: narr("HDFCN52026110005"), cr: 10_800_000 }]))).status).toBe(201);
    const line = await lineOf("HDFCN52026110005");
    expect(line).toMatchObject({ status: "suggested", confidence: "high" });
    expect(line.suggestion.candidates[0]).toMatchObject({ tdsPaise: 1_000_000, tdsRateBp: 1000, tdsSection: "194J", client: { companyName: "Filmy Brands" }, stale: false });
    const r = await confirmTop(line);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const p = r.body.data.payment;
    expect(p).toMatchObject({ mode: "bank_transfer", reference: "HDFCN52026110005", paidOn: d(-1), amountPaise: 10_800_000, tdsPaise: 1_000_000, tdsRateBp: 1000, tdsSection: "194J" });
    expect(p.number).toMatch(/^RCPT\/\d{2}-\d{2}\/0001$/);
    expect(p.bankLine).toMatchObject({ id: line.id, txnDate: d(-1), bankAccount: { label: "IDFC First current", last4: "8788" } });
    expect(r.body.data.line).toMatchObject({ status: "matched", matchedPaise: 10_800_000, remainingPaise: 0 });
    const i = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect([i.status, i.tdsPaise, i.paidPaise]).toEqual(["paid", 1_000_000, 10_800_000]);
    const ev = (await prisma.salesEvent.findMany()).map((e) => `${e.entityType}/${e.action}`);
    for (const x of ["bank_line/receipt_recorded", "payment/bank_matched", "payment/recorded", "invoice/payment_allocated"]) expect(ev).toContain(x);
    await flushSalesBackground();
    expect(sent).toHaveLength(1);
  });

  it("a TDS cut edited by hand (₹1,000 instead of ₹2,000) leaves ₹1,000 open on the invoice", async () => {
    const inv = await issued();
    await importFile(statement([{ date: d(-1), narr: narr("HDFCN52026110006"), cr: 11_600_000 }]));
    const line = await lineOf("HDFCN52026110006");
    const r = await api().post(`/v1/sales/bank/lines/${line.id}/confirm`).set(auth(sales)).send({ clientId: filmy, amountPaise: 11_600_000, tdsPaise: 100_000, tdsRateBp: 100, tdsSection: "194C", allocations: [{ invoiceId: inv.id, amountPaise: 11_600_000, tdsPaise: 100_000 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const i = await api().get(`/v1/sales/invoices/${inv.id}`).set(auth(sales));
    expect(i.body.data).toMatchObject({ balancePaise: 100_000, derivedStatus: "partially_paid" });
  });

  it("two confirms of one line at once: one receipt, one 409, the sequence moves once (R→G)", async () => {
    await issued();
    await importFile(statement([{ date: d(-1), narr: narr("HDFCN52026110007"), cr: 11_800_000 }]));
    const line = await lineOf("HDFCN52026110007");
    const res = await Promise.all([confirmTop(line), confirmTop(line)]);
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(["BANK_LINE_SETTLED", "OVER_MATCHED"]).toContain(res.find((r) => r.status === 409)!.body.error.code);
    expect(await prisma.salesPayment.count()).toBe(1);
    expect(await receiptSeq()).toEqual([2]);
  });

  it("an invoice paid meanwhile → OVER_ALLOCATED, nothing recorded, the sequence untouched", async () => {
    const inv = await issued();
    await importFile(statement([{ date: d(-1), narr: narr("HDFCN52026110008"), cr: 11_800_000 }]));
    const line = await lineOf("HDFCN52026110008");
    await api().post("/v1/sales/payments").set(auth(sales)).send({ clientId: filmy, amountPaise: 11_800_000, mode: "cheque", paidOn: d(-30), allocations: [{ invoiceId: inv.id, amountPaise: 11_800_000 }] });
    const seq = await receiptSeq();
    const r = await confirmTop(line, { ackExistingReceipt: true });
    expect([r.status, r.body.error.code]).toEqual([409, "OVER_ALLOCATED"]);
    expect(await prisma.salesPayment.count()).toBe(1);
    expect(await receiptSeq()).toEqual(seq);
    expect((await prisma.salesBankLine.findUniqueOrThrow({ where: { id: line.id } })).status).toBe("suggested");
  });

  it("refusals: another company's invoice, an ignored line, a withdrawal, more than is left", async () => {
    expect((await api().put("/v1/sales/settings/seller?company=dmpl").set(auth(adminT)).send({ ...SELLER, legalName: "Dashmani Media Private Limited", gstin: "27AAJCD7425L1Z8", pan: "AAJCD7425L", invoicePrefix: "DM", creditNotePrefix: "DMCN", receiptPrefix: "DMRC", quotePrefix: "DMQ", orderPrefix: "DMSO" })).status).toBe(200);
    const dm = await issued(filmy, 10_000_000, d(-10), "dmpl");
    await importFile(statement([{ date: d(-1), narr: narr("HDFCN52026110009"), cr: 11_800_000 }, { date: d(-1), narr: "NEFT DR VENDOR", dr: 1_000 }, { date: d(-1), narr: "INT PD", cr: 1_000 }]));
    const line = await lineOf("HDFCN52026110009");
    const wc = await api().post(`/v1/sales/bank/lines/${line.id}/confirm`).set(auth(sales)).send({ clientId: filmy, amountPaise: 11_800_000, allocations: [{ invoiceId: dm.id, amountPaise: 11_800_000 }] });
    expect(wc.body.error.code).toBe("WRONG_COMPANY");
    const over = await api().post(`/v1/sales/bank/lines/${line.id}/confirm`).set(auth(sales)).send({ clientId: filmy, amountPaise: 11_800_001, allocations: [] });
    expect(over.body.error.code).toBe("OVER_MATCHED");
    const debit = await prisma.salesBankLine.findFirstOrThrow({ where: { debitPaise: { gt: 0 } } });
    expect((await api().post(`/v1/sales/bank/lines/${debit.id}/confirm`).set(auth(sales)).send({ clientId: filmy, amountPaise: 100 })).body.error.code).toBe("BANK_LINE_NOT_CREDIT");
    const interest = await prisma.salesBankLine.findFirstOrThrow({ where: { narration: "INT PD" } });
    await api().post(`/v1/sales/bank/lines/${interest.id}/ignore`).set(auth(sales)).send({ reason: "interest" });
    expect((await api().post(`/v1/sales/bank/lines/${interest.id}/confirm`).set(auth(sales)).send({ clientId: filmy, amountPaise: 100 })).body.error.code).toBe("BANK_LINE_IGNORED");
  });

  it("one credit for two clients: ₹60,000 → partly matched, ₹40,000 → matched; an advance leaves it unallocated", async () => {
    await importFile(statement([{ date: d(-1), narr: "NEFT CR AGENCY HDFCN52026110010", cr: 10_000_000 }]));
    const line = await lineOf("AGENCY");
    const a = await api().post(`/v1/sales/bank/lines/${line.id}/confirm`).set(auth(sales)).send({ clientId: filmy, amountPaise: 6_000_000, allocations: [] });
    expect(a.status).toBe(201);
    expect(a.body.data.line).toMatchObject({ status: "partly_matched", remainingPaise: 4_000_000 });
    expect(a.body.data.payment.unallocatedPaise).toBe(6_000_000);
    const b = await api().post(`/v1/sales/bank/lines/${line.id}/confirm`).set(auth(sales)).send({ clientId: zenith, amountPaise: 4_000_000, allocations: [] });
    expect(b.body.data.line.status).toBe("matched");
  });

  it("double-receipt guard: a hand receipt of the same amount two days earlier → 409; acknowledged → 201 (R→G)", async () => {
    await importFile(statement([{ date: d(-1), narr: narr("HDFCN52026110011"), cr: 500_000 }]));
    const hand = await api().post("/v1/sales/payments").set(auth(sales)).send({ clientId: filmy, amountPaise: 500_000, mode: "upi", paidOn: d(-60) });
    await prisma.salesPayment.update({ where: { id: hand.body.data.id }, data: { paidOn: new Date(`${d(-3)}T00:00:00Z`) } });
    const line = await lineOf("HDFCN52026110011");
    const r = await api().post(`/v1/sales/bank/lines/${line.id}/confirm`).set(auth(sales)).send({ clientId: filmy, amountPaise: 500_000 });
    expect([r.status, r.body.error.code]).toEqual([409, "POSSIBLE_DOUBLE_RECEIPT"]);
    expect(r.body.error.message).toContain(hand.body.data.number);
    expect((await api().post(`/v1/sales/bank/lines/${line.id}/confirm`).set(auth(sales)).send({ clientId: filmy, amountPaise: 500_000, ackExistingReceipt: true })).status).toBe(201);
  });

  it("TDS at 20% → 422 TDS_TOO_HIGH; acknowledged → 201", async () => {
    const inv = await issued();
    await importFile(statement([{ date: d(-1), narr: narr("HDFCN52026110012"), cr: 9_800_000 }]));
    const line = await lineOf("HDFCN52026110012");
    const body = { clientId: filmy, amountPaise: 9_800_000, tdsPaise: 2_000_000, allocations: [{ invoiceId: inv.id, amountPaise: 9_800_000, tdsPaise: 2_000_000 }] };
    const r = await api().post(`/v1/sales/bank/lines/${line.id}/confirm`).set(auth(sales)).send(body);
    expect([r.status, r.body.error.code, r.body.error.message]).toEqual([422, "TDS_TOO_HIGH", "TDS of ₹20,000.00 is 20.0% of the taxable value — above every normal rate. Record it anyway?"]);
    expect((await api().post(`/v1/sales/bank/lines/${line.id}/confirm`).set(auth(sales)).send({ ...body, ackHighTds: true })).status).toBe(201);
  });

  it("link: within the remainder → matched; ₹0.40 short → matched; too large, already linked, razorpay, 62 days apart → refused", async () => {
    await importFile(statement([{ date: d(-1), narr: "NEFT CR LINKME A", cr: 100_000 }, { date: d(-1), narr: "NEFT CR LINKME B", cr: 100_000 }]));
    const a = await lineOf("LINKME A");
    const b = await lineOf("LINKME B");
    const pay = async (amountPaise: number, mode = "upi", paidOn = d(-10)) => (await api().post("/v1/sales/payments").set(auth(sales)).send({ clientId: filmy, amountPaise, mode, paidOn })).body.data;
    const short = await pay(99_960);
    const ok = await api().post(`/v1/sales/bank/lines/${a.id}/link`).set(auth(sales)).send({ paymentId: short.id });
    expect(ok.body.data.line.status).toBe("matched");
    expect((await api().post(`/v1/sales/bank/lines/${b.id}/link`).set(auth(sales)).send({ paymentId: short.id })).body.error.code).toBe("RECEIPT_ALREADY_LINKED");
    expect((await api().post(`/v1/sales/bank/lines/${b.id}/link`).set(auth(sales)).send({ paymentId: (await pay(200_000)).id })).body.error.code).toBe("OVER_MATCHED");
    expect((await api().post(`/v1/sales/bank/lines/${b.id}/link`).set(auth(sales)).send({ paymentId: (await pay(1_000, "razorpay")).id })).body.error.code).toBe("RAZORPAY_RECEIPT");
    const far = await api().post(`/v1/sales/bank/lines/${b.id}/link`).set(auth(sales)).send({ paymentId: (await pay(1_000, "upi", d(-63))).id });
    expect([far.status, far.body.error.code]).toEqual([422, "RECEIPT_DATE_FAR"]);
    const cand = await api().get(`/v1/sales/bank/lines/${b.id}/receipts`).set(auth(sales));
    expect(cand.status).toBe(200);
    expect(cand.body.data.every((x: { amountPaise: number }) => x.amountPaise <= 100_100)).toBe(true);
  });

  it("auto-link at import: a unique same-amount receipt recorded by hand two days earlier", async () => {
    const hand = await api().post("/v1/sales/payments").set(auth(sales)).send({ clientId: filmy, amountPaise: 345_600, mode: "bank_transfer", paidOn: d(-3) });
    const r = await importFile(statement([{ date: d(-1), narr: narr("HDFCN52026110013"), cr: 345_600 }]));
    expect(r.body.data.autoLinked).toBe(1);
    const line = await lineOf("HDFCN52026110013");
    expect(line).toMatchObject({ status: "matched", receipts: [expect.objectContaining({ id: hand.body.data.id })] });
    expect(line.suggestion.candidates).toEqual([]);
    expect((await prisma.salesEvent.findMany({ where: { entityType: "bank_line" } })).map((e) => e.action)).toContain("auto_linked");
  });

  it("unlink: detach keeps the receipt; void reopens the invoice; a live refund blocks the void", async () => {
    const inv = await issued();
    await importFile(statement([{ date: d(-1), narr: narr("HDFCN52026110014"), cr: 11_800_000 }]));
    const line = await lineOf("HDFCN52026110014");
    const p = (await confirmTop(line)).body.data.payment;
    const det = await api().post(`/v1/sales/bank/lines/${line.id}/unlink`).set(auth(sales)).send({ paymentId: p.id, action: "detach", reason: "wrong line" });
    expect(det.status, JSON.stringify(det.body)).toBe(200);
    expect(det.body.data.payment).toMatchObject({ status: "recorded", bankLine: null });
    expect(det.body.data.line.status).not.toBe("matched");
    // The rematch after the detach must not link the same receipt straight back.
    expect(det.body.data.line.suggestion.receiptCandidates.map((x: { paymentId: string }) => x.paymentId)).toEqual([p.id]);
    await api().post(`/v1/sales/bank/lines/${line.id}/link`).set(auth(sales)).send({ paymentId: p.id });
    const v = await api().post(`/v1/sales/bank/lines/${line.id}/unlink`).set(auth(sales)).send({ paymentId: p.id, action: "void", reason: "recorded by mistake" });
    expect(v.body.data.payment.status).toBe("voided");
    expect(["unmatched", "suggested"]).toContain(v.body.data.line.status);
    expect((await prisma.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe("issued");
    // A receipt with a live refund cannot be voided from the line.
    await importFile(statement([{ date: d(-1), narr: "NEFT CR REFUNDABLE", cr: 50_000 }], { opening: 1 }), "nov2.csv");
    const l2 = await lineOf("REFUNDABLE");
    const p2 = (await api().post(`/v1/sales/bank/lines/${l2.id}/confirm`).set(auth(sales)).send({ clientId: filmy, amountPaise: 50_000 })).body.data.payment;
    await api().post(`/v1/sales/payments/${p2.id}/refunds`).set(auth(sales)).send({ amountPaise: 10_000, mode: "upi", refundedOn: today });
    const blocked = await api().post(`/v1/sales/bank/lines/${l2.id}/unlink`).set(auth(sales)).send({ paymentId: p2.id, action: "void", reason: "mistake" });
    expect(blocked.body.error.code).toBe("PAYMENT_HAS_REFUNDS");
    expect((await prisma.salesBankLine.findUniqueOrThrow({ where: { id: l2.id } })).status).toBe("matched");
  });

  it("a voided receipt stays on its line: unlink refuses it; a second void logs nothing more (R→G)", async () => {
    await issued();
    await importFile(statement([{ date: d(-1), narr: narr("HDFCN52026110021"), cr: 11_800_000 }]));
    const line = await lineOf("HDFCN52026110021");
    const p = (await confirmTop(line)).body.data.payment;
    expect((await api().post(`/v1/sales/payments/${p.id}/void`).set(auth(sales)).send({ reason: "bounced" })).status).toBe(200);
    await flushSalesBackground();
    expect((await api().post(`/v1/sales/payments/${p.id}/void`).set(auth(sales)).send({ reason: "bounced again" })).status).toBe(200);
    await flushSalesBackground();
    const voidedEvents = await prisma.salesEvent.count({ where: { entityType: "bank_line", entityId: line.id, action: "receipt_voided" } });
    expect(voidedEvents).toBe(1);
    for (const action of ["detach", "void"]) {
      const r = await api().post(`/v1/sales/bank/lines/${line.id}/unlink`).set(auth(sales)).send({ paymentId: p.id, action, reason: "tidy up" });
      expect([r.status, r.body.error.code]).toEqual([409, "PAYMENT_VOIDED"]);
    }
    expect((await prisma.salesPayment.findUniqueOrThrow({ where: { id: p.id } })).bankLineId).toBe(line.id);
    expect(await prisma.salesEvent.count({ where: { entityType: "bank_line", entityId: line.id, action: "receipt_voided" } })).toBe(1);
  });

  it("matching does not depend on how open credits are paged: two credits for one invoice → one sure (R→G)", async () => {
    setBankLinePageSizeForTests(1);
    try {
      await issued();
      await importFile(statement([
        { date: d(-2), narr: narr("HDFCN52026110031"), cr: 11_800_000 },
        { date: d(-1), narr: narr("HDFCN52026110032"), cr: 11_800_000 },
      ]));
      const lines = await prisma.salesBankLine.findMany({ where: { creditPaise: { gt: 0 } } });
      expect(lines).toHaveLength(2);
      expect(lines.filter((l) => l.confidence === "high")).toHaveLength(1);
      const other = lines.find((l) => l.confidence !== "high")!;
      expect((other.suggestion as { conflict: { invoiceNumber: string } | null }).conflict).not.toBeNull();
    } finally {
      setBankLinePageSizeForTests(2000);
    }
  });

  it("voiding a bank-matched receipt from its own page reopens the line after commit (R→G)", async () => {
    await issued();
    await importFile(statement([{ date: d(-1), narr: narr("HDFCN52026110015"), cr: 11_800_000 }]));
    const line = await lineOf("HDFCN52026110015");
    const p = (await confirmTop(line)).body.data.payment;
    expect((await api().post(`/v1/sales/payments/${p.id}/void`).set(auth(sales)).send({ reason: "bounced" })).status).toBe(200);
    await flushSalesBackground();
    const after = await prisma.salesBankLine.findUniqueOrThrow({ where: { id: line.id } });
    expect(["unmatched", "suggested"]).toContain(after.status);
    expect(after.matchedPaise).toBe(0n);
    expect((await prisma.salesEvent.findMany({ where: { entityType: "bank_line", entityId: line.id } })).map((e) => e.action)).toContain("receipt_voided");
  });

  it("lock order: confirming one line while voiding another line's receipt on the same invoice settles both", async () => {
    const inv = await issued(filmy, 20_000_000);
    await importFile(statement([{ date: d(-1), narr: "NEFT CR LOCK ONE", cr: 5_000_000 }, { date: d(-1), narr: "NEFT CR LOCK TWO", cr: 5_000_000 }]));
    const l1 = await lineOf("LOCK ONE");
    const l2 = await lineOf("LOCK TWO");
    const r2 = (await api().post(`/v1/sales/bank/lines/${l2.id}/confirm`).set(auth(sales)).send({ clientId: filmy, amountPaise: 5_000_000, allocations: [{ invoiceId: inv.id, amountPaise: 5_000_000 }] })).body.data.payment;
    const res = await Promise.all([
      api().post(`/v1/sales/bank/lines/${l1.id}/confirm`).set(auth(sales)).send({ clientId: filmy, amountPaise: 5_000_000, allocations: [{ invoiceId: inv.id, amountPaise: 5_000_000 }], ackExistingReceipt: true }),
      api().post(`/v1/sales/bank/lines/${l2.id}/unlink`).set(auth(sales)).send({ paymentId: r2.id, action: "void", reason: "mistake" }),
    ]);
    expect(res.map((r) => r.status)).toEqual([201, 200]);
  });

  it("ignore with a reason, refusals, reopen; and the owner's bulk 'ignore everything before'", async () => {
    await importFile(statement([{ date: d(-1), narr: "GST REFUND CBIC", cr: 100_000 }, { date: d(-1), narr: "NEFT DR X", dr: 100 }, { date: d(-40), narr: "OLD CREDIT ONE", cr: 1_000 }, { date: d(-45), narr: "OLD CREDIT TWO", cr: 2_000 }]));
    const l = await lineOf("GST REFUND");
    expect(l.suggestion.ignoreHint).toMatchObject({ reason: "gst_refund" });
    expect((await api().post(`/v1/sales/bank/lines/${l.id}/ignore`).set(auth(sales)).send({ reason: "other" })).status).toBe(400);
    const ig = await api().post(`/v1/sales/bank/lines/${l.id}/ignore`).set(auth(sales)).send({ reason: "gst_refund", note: "Sept refund" });
    expect(ig.body.data.line).toMatchObject({ status: "ignored", ignoreReason: "gst_refund" });
    const re = await api().post(`/v1/sales/bank/lines/${l.id}/reopen`).set(auth(sales));
    expect(["unmatched", "suggested"]).toContain(re.body.data.line.status);
    const debit = await prisma.salesBankLine.findFirstOrThrow({ where: { debitPaise: { gt: 0 } } });
    expect((await api().post(`/v1/sales/bank/lines/${debit.id}/reopen`).set(auth(sales))).body.error.code).toBe("BANK_LINE_NOT_CREDIT");
    // A credit with a receipt cannot be ignored.
    const p = await api().post(`/v1/sales/bank/lines/${l.id}/confirm`).set(auth(sales)).send({ clientId: filmy, amountPaise: 1_000 });
    expect(p.status).toBe(201);
    expect((await api().post(`/v1/sales/bank/lines/${l.id}/ignore`).set(auth(sales)).send({ reason: "interest" })).body.error.code).toBe("BANK_LINE_HAS_RECEIPTS");
    // Bulk ignore is an admin action, and a dry run counts without changing anything.
    expect((await api().post("/v1/sales/bank/lines/ignore-before?company=dspl").set(auth(sales)).send({ before: d(-30), reason: "other", note: "Swipe-era credits" })).status).toBe(403);
    const dry = await api().post("/v1/sales/bank/lines/ignore-before?company=dspl").set(auth(adminT)).send({ before: d(-30), reason: "other", note: "Swipe-era credits", dryRun: true });
    expect(dry.body.data).toEqual({ wouldIgnore: 2, wouldIgnorePaise: 3_000 });
    expect(await prisma.salesBankLine.count({ where: { narration: { startsWith: "OLD CREDIT" }, status: "ignored" } })).toBe(0);
    const bulk = await api().post("/v1/sales/bank/lines/ignore-before?company=dspl").set(auth(adminT)).send({ before: d(-30), reason: "other", note: "Swipe-era credits" });
    expect(bulk.body.data).toEqual({ ignored: 2 });
    expect((await prisma.salesBankLine.findMany({ where: { narration: { startsWith: "OLD CREDIT" } } })).every((x) => x.status === "ignored" && x.ignoreNote === "Swipe-era credits")).toBe(true);
    expect((await prisma.salesBankLine.findUniqueOrThrow({ where: { id: l.id } })).status).toBe("partly_matched");
  });

  it("a re-export without the balance column and with re-worded narrations is flagged; confirm needs an acknowledgement", async () => {
    await importFile(statement([{ date: d(-1), narr: narr("HDFCN52026110016"), cr: 700_000 }]), "oct.csv");
    const r = await importFile(statement([{ date: d(-1), narr: "NEFT-FILMY BRANDS-HDFCN52026110016", cr: 700_000 }], { balance: false }), "oct-2.csv");
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const dup = await prisma.salesBankLine.findFirstOrThrow({ where: { possibleDuplicate: true } });
    const c = await api().post(`/v1/sales/bank/lines/${dup.id}/confirm`).set(auth(sales)).send({ clientId: filmy, amountPaise: 700_000 });
    expect([c.status, c.body.error.code]).toEqual([409, "POSSIBLE_DUPLICATE"]);
    expect(c.body.error.message).toContain("row 4 of oct.csv");
  });

  it("cut-over: credits before the account's match-from day import as ignored and are never suggested", async () => {
    await issued(filmy, 10_000_000, d(-60));
    await api().put(`/v1/sales/bank/accounts/${accountId}`).set(auth(adminT)).send({ matchFrom: d(-5) });
    await importFile(statement([{ date: d(-20), narr: narr("HDFCN52026100017"), cr: 11_800_000 }]));
    const l = await prisma.salesBankLine.findFirstOrThrow();
    expect([l.status, l.ignoreReason, l.suggestion]).toEqual(["ignored", "before_cutover", null]);
  });

  it("Confirm all sure confirms only sure, conflict-free lines and explains the rest", async () => {
    await issued();
    await issued(zenith, 5_000_000);
    await importFile(statement([
      { date: d(-1), narr: narr("HDFCN52026110018"), cr: 11_800_000 },
      { date: d(-1), narr: "NEFT CR SOMEONE 5900000", cr: 5_900_000 },
    ]));
    const sure = await lineOf("HDFCN52026110018");
    const likely = await lineOf("SOMEONE");
    const r = await api().post("/v1/sales/bank/lines/confirm-sure").set(auth(sales)).send({ lineIds: [sure.id, likely.id] });
    expect(r.status).toBe(200);
    expect(r.body.data.confirmed.map((x: { lineId: string }) => x.lineId)).toEqual([sure.id]);
    expect(r.body.data.skipped).toEqual([{ lineId: likely.id, message: "It is no longer marked sure — review it" }]);
  });

  it("delete a statement: refused once a receipt (even voided) came from it; otherwise lines go, the event stays", async () => {
    await importFile(statement([{ date: d(-1), narr: "NEFT CR DELETE ME", cr: 50_000 }]));
    const s = await prisma.salesBankStatement.findFirstOrThrow();
    const l = await lineOf("DELETE ME");
    const p = (await api().post(`/v1/sales/bank/lines/${l.id}/confirm`).set(auth(sales)).send({ clientId: filmy, amountPaise: 50_000 })).body.data.payment;
    await api().post(`/v1/sales/payments/${p.id}/void`).set(auth(sales)).send({ reason: "test" });
    const used = await api().delete(`/v1/sales/bank/statements/${s.id}`).set(auth(adminT)).send({ reason: "wrong file" });
    expect([used.status, used.body.error.code]).toEqual([409, "STATEMENT_IN_USE"]);
    await prisma.salesPayment.update({ where: { id: p.id }, data: { bankLineId: null } });
    const ok = await api().delete(`/v1/sales/bank/statements/${s.id}`).set(auth(adminT)).send({ reason: "wrong file" });
    expect(ok.body.data).toEqual({ deleted: true });
    expect(await prisma.salesBankLine.count()).toBe(0);
    expect((await prisma.salesEvent.findMany({ where: { entityType: "bank_statement" } })).map((e) => e.action).sort()).toEqual(["deleted", "imported"]);
  });

  it("dashboard: this month's unmatched credits only, this company only; null without an account; no bank events in the feed (R→G)", async () => {
    const [y, m] = today.split("-").map(Number);
    const first = `${y}-${String(m).padStart(2, "0")}-01`;
    const lastPrev = new Date(Date.parse(`${first}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    await api().put(`/v1/sales/bank/accounts/${accountId}`).set(auth(adminT)).send({ matchFrom: null });
    await importFile(statement([{ date: lastPrev, narr: "NEFT CR PREV MONTH", cr: 1_000 }, { date: first, narr: "NEFT CR THIS MONTH", cr: 2_000 }]));
    const dm = await api().post("/v1/sales/bank/accounts").set(auth(adminT)).send({ companyKey: "dmpl", label: "ICICI current", bank: "icici", accountNumber: "000405123456" });
    expect(dm.status).toBe(201);
    const dash = (await api().get("/v1/sales/dashboard?company=dspl").set(auth(sales))).body.data;
    expect(dash.bank).toMatchObject({ unmatchedMonthCount: 1, unmatchedMonthPaise: 2_000, openCount: 2, openPaise: 3_000, accounts: [expect.objectContaining({ last4: "8788" })] });
    expect(dash.recent.some((e: { entityType: string }) => e.entityType.startsWith("bank_"))).toBe(false);
    await prisma.salesBankAccount.deleteMany({ where: { companyKey: "dmpl" } });
    expect((await api().get("/v1/sales/dashboard?company=dmpl").set(auth(sales))).body.data.bank).toBeNull();
  });

  it("a ₹3 crore credit imports; one receipt cannot hold it, two of ₹1.5 crore match it", async () => {
    await importFile(statement([{ date: d(-1), narr: "RTGS CR BIG CLIENT", cr: 3_000_000_000 }], { opening: 0 }));
    const l = await lineOf("BIG CLIENT");
    expect(l).toMatchObject({ creditPaise: 3_000_000_000, suggestion: { note: "too_large" } });
    expect((await api().post(`/v1/sales/bank/lines/${l.id}/confirm`).set(auth(sales)).send({ clientId: filmy, amountPaise: 3_000_000_000 })).status).toBe(400);
    expect((await api().post(`/v1/sales/bank/lines/${l.id}/confirm`).set(auth(sales)).send({ clientId: filmy, amountPaise: 1_500_000_000 })).status).toBe(201);
    const second = await api().post(`/v1/sales/bank/lines/${l.id}/confirm`).set(auth(sales)).send({ clientId: filmy, amountPaise: 1_500_000_000, ackExistingReceipt: true });
    expect(second.body.data.line.status).toBe("matched");
  });

  it("payments: a TDS section without TDS is refused; the events route accepts bank lines", async () => {
    const bad = await api().post("/v1/sales/payments").set(auth(sales)).send({ clientId: filmy, amountPaise: 100, mode: "upi", paidOn: today, tdsSection: "194C" });
    expect(bad.status).toBe(400);
    expect((await api().post("/v1/sales/payments").set(auth(sales)).send({ clientId: filmy, amountPaise: 100, mode: "upi", paidOn: today })).status).toBe(201);
    expect((await api().get("/v1/sales/events?entityType=bank_line&entityId=x").set(auth(sales))).status).toBe(200);
  });

  it("bank writes switch off with SALES_BANK_ENABLED=0; reads keep working", async () => {
    vi.stubEnv("SALES_BANK_ENABLED", "0");
    try {
      const r = await api().post("/v1/sales/bank/rematch?company=dspl").set(auth(sales));
      expect([r.status, r.body.error.code]).toEqual([503, "BANK_OFF"]);
      expect((await api().get("/v1/sales/bank/accounts").set(auth(sales))).status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
