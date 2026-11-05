/**
 * The Bank tab of /reconcile on a real database (spec-reconcile §10.5, S-1…S-12). The §5.4.8 month
 * is built through BANK'S OWN ROUTES: the account by POST /sales/bank/accounts, sep/oct/nov
 * statements previewed and imported, receipts recorded through /sales/payments and linked or
 * ignored on Bank. Statements are CSV strings built here — no binary fixtures.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import zlib from "zlib";
import request from "supertest";
import { prisma } from "@dashmani/db";
import { todayIST } from "@dashmani/shared";

vi.mock("../src/services/email.service", async (orig) => {
  const real = await orig<typeof import("../src/services/email.service")>();
  return { ...real, sendEmail: vi.fn(async () => ({ messageId: "test" })) };
});

import app from "../src/app";
import { flushSalesBackground } from "../src/services/sales/common";
import { brsFingerprints } from "../src/services/sales/recon/brs-sql";
import { createTestRole, createTestUser, generateToken } from "./helpers";

const R = (rupees: number) => Math.round(rupees * 100);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const ACC = "88452818788";
const SELLER = {
  legalName: "Digital Sukoon Private Limited", gstin: "27AAKCD3352K1ZF", pan: "AAKCD3352K", addressLine1: "702 Parinee I, Andheri West", city: "Mumbai",
  state: "Maharashtra", stateCode: "27", pincode: "400053", invoicePrefix: "INV", creditNotePrefix: "CN", receiptPrefix: "RCPT", defaultDueDays: 15, roundToRupee: true,
  email: "accounts@ds.test", autoEmailInvoices: false, accountNumber: ACC,
};
const dmy = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
const rs = (paise: number) => (paise / 100).toFixed(2);

type Row = { date: string; narr: string; dr?: number; cr?: number };
/** An IDFC-layout statement; balances run from `opening` unless `balance: false`; `breakAt` shifts later balances by ₹500. */
function statement(rows: Row[], o: { opening: number; balance?: boolean; account?: string; breakAt?: number; openingRow?: boolean }): Buffer {
  let bal = o.opening;
  const withBal = o.balance !== false;
  const out: string[][] = [[`Account No : ${o.account ?? ACC}`], [], ["Transaction Date", "Particulars", "Cheque No", "Debit", "Credit", ...(withBal ? ["Balance"] : [])]];
  if (o.openingRow) out.push(["", "Opening Balance", "", "", rs(o.opening), ...(withBal ? [rs(o.opening)] : [])]);
  rows.forEach((r, i) => {
    bal += (r.cr ?? 0) - (r.dr ?? 0);
    if (o.breakAt !== undefined && i === o.breakAt) bal += R(500);
    out.push([dmy(r.date), r.narr, "", r.dr ? rs(r.dr) : "", r.cr ? rs(r.cr) : "", ...(withBal ? [rs(bal)] : [])]);
  });
  return Buffer.from(out.map((r) => r.map((c) => (/[",]/.test(c) ? `"${c}"` : c)).join(",")).join("\r\n"));
}

interface World { sales: string; viewer: string; admin: string; filmy: string; kanara: string; accountId: string }

async function seedWorld(): Promise<World> {
  await prisma.systemSetting.deleteMany({ where: { key: { startsWith: "sales.seller" } } });
  await createTestRole("Sales", ["view", "manage"].map((action) => ({ resource: "sales", action, scope: "global" })));
  await createTestRole("Viewer", [{ resource: "sales", action: "view", scope: "global" }]);
  await createTestRole("Admin", ["view", "manage", "approve"].map((action) => ({ resource: "sales", action, scope: "global" })));
  const mk = async (name: string, role: string) => { const u = await createTestUser({ name, roleNames: [role] }); return generateToken(u.id, u.email, [role]); };
  const sales = await mk("Riya Shah", "Sales");
  const viewer = await mk("Vik Viewer", "Viewer");
  const admin = await mk("Boss Admin", "Admin");
  expect((await request(app).put("/v1/sales/settings/seller").set(auth(admin)).send(SELLER)).status).toBe(200);
  const client = async (name: string) => (await prisma.client.create({ data: { companyName: name, contactName: "X", email: `${name.replace(/\W/g, "").toLowerCase()}@c.test`, passwordHash: "x" } })).id;
  const filmy = await client("Filmy Brands");
  const kanara = await client("Kanara Foods");
  const a = await request(app).post("/v1/sales/bank/accounts").set(auth(admin)).send({ companyKey: "dspl", label: "IDFC First", bank: "idfc", accountNumber: ACC, ifsc: "IDFB0040178" });
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  return { sales, viewer, admin, filmy, kanara, accountId: a.body.data.id };
}

const api = () => request(app);
async function importFile(w: World, file: Buffer, name: string, accountId = w.accountId, token = w.sales, company = "dspl") {
  const p = await api().post(`/v1/sales/bank/statements/preview?company=${company}`).set(auth(token)).field("bankAccountId", accountId).attach("file", file, name);
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  const r = await api().post(`/v1/sales/bank/statements?company=${company}`).set(auth(token))
    .field("bankAccountId", accountId).field("mapping", JSON.stringify(p.body.data.mapping ?? {})).field("expectedSha256", p.body.data.fileSha256)
    .field("acceptWarnings", "true").attach("file", file, name);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await flushSalesBackground();
  return r.body.data;
}
async function receipt(w: World, paidOn: string, amount: number, mode = "bank_transfer", clientId = w.filmy, company = "dspl") {
  const r = await api().post(`/v1/sales/payments?company=${company}`).set(auth(w.sales)).send({ companyKey: company, clientId, amountPaise: amount, mode, paidOn, allocations: [] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data as { id: string; number: string };
}
const lineByNarr = (narr: string) => prisma.salesBankLine.findFirstOrThrow({ where: { narration: narr } });
async function link(w: World, narr: string, paymentId: string) {
  const p = await prisma.salesPayment.findUniqueOrThrow({ where: { id: paymentId } });
  if (p.bankLineId) return;
  const l = await lineByNarr(narr);
  const r = await api().post(`/v1/sales/bank/lines/${l.id}/link`).set(auth(w.sales)).send({ paymentId });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  await flushSalesBackground();
}
async function ignore(w: World, narr: string, reason: string) {
  const l = await lineByNarr(narr);
  const r = await api().post(`/v1/sales/bank/lines/${l.id}/ignore`).set(auth(w.sales)).send({ reason });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  await flushSalesBackground();
}
const brs = (w: World, month = "2026-10", token = w.sales, extra = "") => api().get(`/v1/sales/reconcile/bank?company=dspl&accountId=${w.accountId}&month=${month}${extra}`).set(auth(token));
const reconcile = (w: World, body: Record<string, unknown>, token = w.sales) => api().post("/v1/sales/reconcile/bank/reconcile?company=dspl").set(auth(token)).send({ accountId: w.accountId, month: "2026-10", ...body });

/** The §5.4.8 month, built through bank's routes. */
async function buildOctober(w: World) {
  const r38 = await receipt(w, "2026-09-30", R(50000));
  const r40 = await receipt(w, "2026-10-14", R(118000));
  const refund = await api().post(`/v1/sales/payments/${r40.id}/refunds`).set(auth(w.sales)).send({ amountPaise: R(50000), mode: "bank_transfer", refundedOn: "2026-10-15" });
  expect(refund.status, JSON.stringify(refund.body)).toBe(201);
  const r41 = await receipt(w, "2026-10-20", R(108000));
  const r43 = await receipt(w, "2026-10-29", R(25000), "cheque", w.kanara);
  const r44 = await receipt(w, "2026-10-30", R(60000), "upi");
  const r45 = await receipt(w, "2026-10-31", R(10000));
  await receipt(w, "2026-10-10", R(20000), "razorpay");
  await receipt(w, "2026-10-18", R(25000), "razorpay");
  await receipt(w, "2026-10-08", R(5000), "cash");
  await importFile(w, statement([{ date: "2026-09-10", narr: "NEFT CR SEP OPENING FLOW", cr: R(2118.4) }, { date: "2026-09-30", narr: "NEFT CR SEPT LAST", cr: R(100000) }], { opening: R(300000) }), "sep.csv");
  await importFile(w, statement([
    { date: "2026-10-02", narr: "NEFT CR FILMY BRANDS 0038", cr: R(50000) },
    { date: "2026-10-05", narr: "ATM WDL OFFICE CASH", dr: R(40000) },
    { date: "2026-10-14", narr: "NEFT CR FILMY BRANDS 0040", cr: R(118000) },
    { date: "2026-10-15", narr: "IMPS REFUND FILMY", dr: R(50000) },
    { date: "2026-10-20", narr: "NEFT CR FILMY BRANDS 0041", cr: R(108000.4) },
    { date: "2026-10-22", narr: "INT CREDIT FD 9921", cr: R(2500) },
    { date: "2026-10-25", narr: "OWN TRF FROM ICICI 4421", cr: R(300000) },
    { date: "2026-10-26", narr: "VENDOR PAYMENT EDITS", dr: R(60000) },
    { date: "2026-10-28", narr: "NEFT CR UNKNOWN PAYER", cr: R(40000) },
    { date: "2026-10-29", narr: "RENT OCTOBER", dr: R(30000) },
    { date: "2026-10-30", narr: "SALARY ADVANCE STAFF", dr: R(35000) },
    { date: "2026-10-31", narr: "NEFT CR FILMY BRANDS 0045", cr: R(15000) },
    { date: "2026-10-31", narr: "GST PAYMENT OCT", dr: R(30000) },
  ], { opening: R(402118.4) }), "oct.csv");
  await importFile(w, statement([{ date: "2026-11-02", narr: "UPI CR FILMY 0044", cr: R(60000) }, { date: "2026-11-04", narr: "NEFT CR NOV OTHER", cr: R(7777) }], { opening: R(790618.8) }), "nov.csv");
  await link(w, "NEFT CR FILMY BRANDS 0038", r38.id);
  await link(w, "NEFT CR FILMY BRANDS 0040", r40.id);
  await link(w, "NEFT CR FILMY BRANDS 0041", r41.id);
  await link(w, "NEFT CR FILMY BRANDS 0045", r45.id);
  await link(w, "UPI CR FILMY 0044", r44.id);
  await ignore(w, "INT CREDIT FD 9921", "interest");
  await ignore(w, "OWN TRF FROM ICICI 4421", "own_transfer");
  return { r38, r40, r41, r43, r44, r45 };
}

function pdfText(buf: Buffer): string {
  const s = buf.toString("latin1");
  let text = "";
  for (const m of s.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let body: string;
    try { body = zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1"); } catch { continue; }
    for (const h of body.matchAll(/<([0-9a-fA-F]+)>/g)) text += Buffer.from(h[1], "hex").toString("latin1");
    text += " ";
  }
  return text;
}

const MONEY = ["sales_invoices", "sales_payments", "sales_payment_allocations", "sales_credit_notes", "sales_refunds", "sales_bank_lines"];
async function moneySnapshot() {
  const out: Record<string, string> = {};
  for (const t of MONEY) {
    const col = t === "sales_invoices" || t === "sales_bank_lines" ? "updated_at" : t === "sales_payment_allocations" ? "id" : "created_at";
    const [r] = await prisma.$queryRawUnsafe<Array<{ n: bigint; m: unknown }>>(`SELECT count(*) AS n, max(${col})::text AS m FROM ${t}`);
    out[t] = `${r.n}|${r.m}`;
  }
  const [p] = await prisma.$queryRawUnsafe<Array<{ h: string }>>(`SELECT md5(string_agg(id || status || coalesce(bank_line_id,''), ',' ORDER BY id)) AS h FROM sales_payments`);
  out.payments = p.h;
  return out;
}

describe("BRS — routes + DB (§10.5)", () => {
  let w: World;
  beforeEach(async () => { w = await seedWorld(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("S-1 the §5.4.8 month built through bank's routes equals B-1; the months list shows September–November", async () => {
    const { r43, r44 } = await buildOctober(w);
    const res = await brs(w);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const v = res.body.data;
    expect(v.ties).toBe(true);
    expect(v.balances).toMatchObject({ source: "statement", openingPaise: R(402118.4), creditsPaise: R(633500.4), creditCount: 7, debitsPaise: R(245000), debitCount: 6, closingPaise: R(790618.8), breaks: [], agreesWith: "oct.csv" });
    const f = Object.fromEntries(v.formula.map((x: { key: string; paise: number }) => [x.key, x.paise]));
    expect(f).toEqual({ books: R(321000), not_credited: R(85000), credited_other_month: R(50000), unmatched: R(45000), ignored: R(302500), rounding: 40, credits: R(633500.4) });
    expect(v.openItems).toEqual({ count: 3, paise: R(70000) });
    expect(v.coverage).toMatchObject({ complete: true, gaps: [] });
    expect(v.items.find((i: { key: string }) => i.key === `nc:${r43.id}`)).toMatchObject({ reason: { code: "CHEQUE_CLEARING" }, open: true });
    expect(v.items.find((i: { key: string }) => i.key === `nc:${r44.id}`)).toMatchObject({ reason: { code: "CREDITED_LATER", text: "credited 2 Nov 2026" }, open: false });
    expect(v.books.excluded).toMatchObject({ cashPaise: R(5000), cashCount: 1, razorpayPaise: R(45000), razorpayCount: 2 });
    expect(v.debits.lines.find((d: { amountPaise: number; day: string }) => d.day === "2026-10-15").refund.number).toMatch(/^RF\//);
    expect(v.defaultAccount).toMatchObject({ id: w.accountId, why: "only" });
    expect(v.state).toBe("open");
    expect(v.fingerprint).toMatch(/^[a-f0-9]{32}$/);
    const months = await api().get(`/v1/sales/reconcile/bank/months?company=dspl`).set(auth(w.sales));
    expect(months.status).toBe(200);
    const keys = months.body.data.months.map((m: { month: string }) => m.month);
    expect(keys).toEqual(expect.arrayContaining(["2026-11", "2026-10", "2026-09"]));
    expect(keys.indexOf("2026-10")).toBeLessThan(keys.indexOf("2026-09"));
    expect(months.body.data.months.find((m: { month: string }) => m.month === "2026-10")).toMatchObject({ state: "open", creditsPaise: R(633500.4), debitsPaise: R(245000), lineCount: 13, coverage: "complete" });
  });

  it("S-2 reconcile: stale fingerprint 409, running month 422, open items 409, then 201 v1 with frozen BIGINT figures and the event; again 200 unchanged", async () => {
    await buildOctober(w);
    const v = (await brs(w)).body.data;
    expect((await reconcile(w, { fingerprint: "0".repeat(32) })).body.error.code).toBe("BRS_CHANGED");
    const cur = todayIST().slice(0, 7);
    const running = await api().post("/v1/sales/reconcile/bank/reconcile?company=dspl").set(auth(w.sales)).send({ accountId: w.accountId, month: cur, fingerprint: (await brs(w, cur)).body.data.fingerprint });
    expect(running.status).toBe(422);
    expect(running.body.error.code).toBe("MONTH_NOT_OVER");
    const open = await reconcile(w, { fingerprint: v.fingerprint });
    expect(open.status).toBe(409);
    expect(open.body.error).toMatchObject({ code: "BRS_OPEN_ITEMS", message: '3 items (₹70,000.00) are still open — tick "Carry them as reconciling items" to reconcile.' });
    const ok = await reconcile(w, { fingerprint: v.fingerprint, acceptOpenItems: true, note: "Cheque 0043 clears in Nov" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data).toMatchObject({ unchanged: false, version: 1 });
    const so = await prisma.salesBrsSignoff.findFirstOrThrow({ where: { bankAccountId: w.accountId, month: "2026-10" } });
    expect(so).toMatchObject({ version: 1, activeKey: `${w.accountId}:2026-10`, fingerprint: v.fingerprint, balanceSource: "statement", openItemCount: 3, accepted: ["open_items"] });
    expect(so.closingPaise).toBe(BigInt(R(790618.8)));
    expect(so.booksPaise).toBe(BigInt(R(321000)));
    expect(so.openItemsPaise).toBe(BigInt(R(70000)));
    const ev = await prisma.salesEvent.findFirstOrThrow({ where: { entityType: "brs_month", entityId: `${w.accountId}:2026-10`, action: "reconciled" } });
    expect(ev.note).toBe(`v1 · closing ₹7,90,618.80 · books ₹3,21,000.00 · 3 open items ₹70,000.00 · fp ${v.fingerprint.slice(0, 8)}`);
    const again = await reconcile(w, { fingerprint: v.fingerprint, acceptOpenItems: true });
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ unchanged: true, version: 1 });
    const after = (await brs(w)).body.data;
    expect(after).toMatchObject({ state: "reconciled", signoff: { version: 1, reconciledByName: "Riya Shah", note: "Cheque 0043 clears in Nov" } });
    const events = await api().get(`/v1/sales/events?entityType=brs_month&entityId=${w.accountId}:2026-10`).set(auth(w.sales));
    expect(events.status).toBe(200);
    // The CSV of the sign-off says who reconciled it, not only who downloaded it.
    const csv = (await api().get(`/v1/sales/reconcile/bank/brs.csv?company=dspl&accountId=${w.accountId}&month=2026-10`).set(auth(w.admin))).text.replace(/^\uFEFF/, "").split("\r\n");
    expect(csv).toContain("Reconciled by,Riya Shah");
    expect(csv).toContain("Note,Cheque 0043 clears in Nov");
    expect(csv).toContain("Acknowledged,open items");
    expect(csv.find((r) => r.startsWith("Source,"))).toContain("by Boss Admin");
  });

  it("S-3 a later statement adds an October line → changed (naming the file and uploader); v1's PDF/CSV keep v1; reconcile again → v2, v1 superseded re_reconciled (R→G)", async () => {
    await buildOctober(w);
    const v1 = (await brs(w)).body.data;
    expect((await reconcile(w, { fingerprint: v1.fingerprint, acceptOpenItems: true })).status).toBe(201);
    await importFile(w, statement([{ date: "2026-10-31", narr: "NEFT CR LATE OCT ENTRY", cr: R(1234) }, { date: "2026-11-03", narr: "NEFT CR LATE NOV", cr: R(10) }], { opening: R(790618.8) }), "late.csv");
    const ch = (await brs(w)).body.data;
    expect(ch.state).toBe("changed");
    expect(ch.changes.newLines).toEqual([expect.objectContaining({ fileName: "late.csv", uploadedByName: "Riya Shah", lines: 1 })]);
    expect(ch.changes.added.map((i: { reason: { code: string } }) => i.reason.code)).toContain("NO_MATCH");
    expect(ch.changes.figures.find((f: { key: string }) => f.key === "credits")).toMatchObject({ frozenPaise: R(633500.4), livePaise: R(633500.4 + 1234) });
    const csv1 = await api().get(`/v1/sales/reconcile/bank/brs.csv?company=dspl&accountId=${w.accountId}&month=2026-10&version=1`).set(auth(w.sales));
    expect(csv1.status).toBe(200);
    expect(csv1.text).toContain("Credits,633500.40");
    expect(csv1.text).not.toContain("634734.40");
    const pdf1 = await api().get(`/v1/sales/reconcile/bank/brs.pdf?company=dspl&accountId=${w.accountId}&month=2026-10&version=1`).set(auth(w.sales)).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on("data", (d: Buffer) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); });
    expect(pdfText(pdf1.body as Buffer)).toContain("RECONCILED");
    // late.csv overlaps 31 Oct, so its opening does not meet that day's start: a break to acknowledge.
    expect(ch.balances.breaks.map((b: { kind: string }) => b.kind)).toContain("statement_open");
    const ok = await reconcile(w, { fingerprint: ch.fingerprint, acceptOpenItems: true, acceptBreaks: true, note: "late.csv is a re-download overlapping 31 Oct" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.version).toBe(2);
    const all = await prisma.salesBrsSignoff.findMany({ where: { bankAccountId: w.accountId, month: "2026-10" }, orderBy: { version: "asc" } });
    expect(all.map((s) => [s.version, s.activeKey !== null, s.supersedeKind])).toEqual([[1, false, "re_reconciled"], [2, true, null]]);
    expect((await brs(w)).body.data.versions.map((x: { version: number }) => x.version)).toEqual([2, 1]);
  });

  it("S-4 voiding an October-linked receipt → changed and no longer counted; linking a September receipt to an October credit leaves September reconciled (R→G)", async () => {
    const { r41 } = await buildOctober(w);
    const v = (await brs(w)).body.data;
    expect((await reconcile(w, { fingerprint: v.fingerprint, acceptOpenItems: true })).status).toBe(201);
    // September: reconcile it first (its unlinked September receipt is an open item).
    const sepRcpt = await receipt(w, "2026-09-28", R(40000));
    const sep = (await brs(w, "2026-09")).body.data;
    expect((await reconcile(w, { month: "2026-09", fingerprint: sep.fingerprint, acceptOpenItems: true, acceptCoverageGaps: true, note: "September statement starts on the 10th" })).status, JSON.stringify(sep.blockers)).toBe(201);
    // Link September's receipt to October's unknown ₹40,000 credit.
    await link(w, "NEFT CR UNKNOWN PAYER", sepRcpt.id);
    expect((await brs(w, "2026-09")).body.data.state).toBe("reconciled");
    expect((await brs(w)).body.data.state).toBe("changed"); // October gained a credited-other-month item
    // Void RCPT/0041 → October changes and the receipt no longer counts.
    const voided = await api().post(`/v1/sales/payments/${r41.id}/void`).set(auth(w.sales)).send({ reason: "bounced" });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    await flushSalesBackground();
    const after = (await brs(w)).body.data;
    expect(after.state).toBe("changed");
    expect(after.books.receiptsPaise).toBe(R(321000 - 108000));
    expect(after.items.find((i: { key: string }) => i.key.startsWith("line:") && i.line?.narration === "NEFT CR FILMY BRANDS 0041")).toMatchObject({ group: "unmatched", amountPaise: R(108000.4) });
    expect(after.ties).toBe(true);
  });

  it("S-5 reopen with a reason → open with the reopen line; reopening an open month → 409 BRS_NOT_RECONCILED", async () => {
    await buildOctober(w);
    const v = (await brs(w)).body.data;
    const reopen = (reason: string) => api().post("/v1/sales/reconcile/bank/reopen?company=dspl").set(auth(w.sales)).send({ accountId: w.accountId, month: "2026-10", reason });
    expect((await reopen("cheque bounced")).body.error.code).toBe("BRS_NOT_RECONCILED");
    expect((await reconcile(w, { fingerprint: v.fingerprint, acceptOpenItems: true })).status).toBe(201);
    const r = await reopen("cheque bounced");
    expect(r.status).toBe(200);
    const after = (await brs(w)).body.data;
    expect(after).toMatchObject({ state: "open", signoff: null, reopened: { byName: "Riya Shah", reason: "cheque bounced" } });
    expect(await prisma.salesBrsSignoff.findFirst({ where: { bankAccountId: w.accountId, supersedeKind: "reopened" } })).toBeTruthy();
    expect(await prisma.salesEvent.count({ where: { entityType: "brs_month", action: "reopened" } })).toBe(1);
    // v1's files now say they were withdrawn (R→G).
    const pdf1 = await api().get(`/v1/sales/reconcile/bank/brs.pdf?company=dspl&accountId=${w.accountId}&month=2026-10&version=1`).set(auth(w.sales)).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on("data", (d: Buffer) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); });
    const t = pdfText(pdf1.body as Buffer);
    expect(t).toContain("SUPERSEDED");
    expect(t).toContain("cheque bounced");
    const csv1 = await api().get(`/v1/sales/reconcile/bank/brs.csv?company=dspl&accountId=${w.accountId}&month=2026-10&version=1`).set(auth(w.sales));
    expect(csv1.text).toMatch(/reconciled version 1 — superseded/);
    expect(csv1.text).toContain("Superseded,reopened");
  });

  it("S-6 a coverage gap and a statement break need their tick and a note ≥ 10 chars; a statement without balances needs a typed closing", async () => {
    // August on a statement without balances, covering 3–20 Aug only.
    await importFile(w, statement([{ date: "2026-08-03", narr: "NEFT CR AUG ONE", cr: R(1000) }, { date: "2026-08-20", narr: "ATM AUG", dr: R(300) }], { opening: 0, balance: false }), "aug.csv");
    const aug = (await brs(w, "2026-08")).body.data;
    expect(aug.balances.source).toBe("unknown");
    expect(aug.needsAck).toEqual(expect.arrayContaining(["coverage_gap", "typed_closing", "open_items"]));
    const base = { month: "2026-08", fingerprint: aug.fingerprint, acceptOpenItems: true };
    expect((await reconcile(w, base)).body.error.code).toBe("BRS_COVERAGE_GAP");
    const short = await reconcile(w, { ...base, acceptCoverageGaps: true, note: "short" });
    expect(short.status).toBe(400);
    const noBal = await reconcile(w, { ...base, acceptCoverageGaps: true, note: "No transactions outside 3–20 Aug" });
    expect(noBal.body.error.code).toBe("BRS_BALANCE_UNKNOWN");
    const typed = await reconcile(w, { ...base, acceptCoverageGaps: true, note: "No transactions outside 3–20 Aug", typedClosingPaise: R(10700) });
    expect(typed.status, JSON.stringify(typed.body)).toBe(201);
    const so = await prisma.salesBrsSignoff.findFirstOrThrow({ where: { month: "2026-08" } });
    expect(so).toMatchObject({ balanceSource: "typed", closingPaise: BigInt(R(10700)), openingPaise: BigInt(R(10000)) });
    expect((await brs(w, "2026-08")).body.data).toMatchObject({ state: "reconciled", balances: { source: "typed", closingPaise: R(10700) } });
    // §5.4.7: a typed month that changes is reconciled again directly — the dialog sends no closing, the frozen one is kept (R→G).
    await importFile(w, statement([{ date: "2026-08-25", narr: "NEFT CR AUG TWO", cr: R(50) }], { opening: 0, balance: false }), "aug2.csv");
    const ch = (await brs(w, "2026-08")).body.data;
    expect(ch).toMatchObject({ state: "changed", balances: { source: "typed", closingPaise: R(10700) } });
    expect(ch.needsAck).not.toContain("typed_closing");
    const again = await reconcile(w, { ...base, fingerprint: ch.fingerprint, acceptCoverageGaps: true, note: "No transactions outside 3–25 Aug" });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.data.version).toBe(2);
    expect(await prisma.salesBrsSignoff.findFirstOrThrow({ where: { month: "2026-08", activeKey: { not: null } } })).toMatchObject({ balanceSource: "typed", closingPaise: BigInt(R(10700)) });
    // A mistyped closing is corrected by reconciling again with the right figure (R→G); the same figure again is unchanged.
    const fixed = await reconcile(w, { ...base, fingerprint: ch.fingerprint, acceptCoverageGaps: true, note: "Closing corrected from the bank's PDF", typedClosingPaise: R(10800) });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(201);
    expect(fixed.body.data.version).toBe(3);
    expect((await reconcile(w, { ...base, fingerprint: ch.fingerprint, acceptCoverageGaps: true, note: "Closing corrected from the bank's PDF", typedClosingPaise: R(10800) })).body.data).toMatchObject({ unchanged: true, version: 3 });
    // July: a statement whose balances break mid-way.
    await importFile(w, statement([
      { date: "2026-07-01", narr: "NEFT CR JUL A", cr: R(100) }, { date: "2026-07-14", narr: "NEFT CR JUL B", cr: R(200) }, { date: "2026-07-31", narr: "NEFT CR JUL C", cr: R(300) },
    ], { opening: R(5000), breakAt: 1 }), "jul.csv");
    const jul = (await brs(w, "2026-07")).body.data;
    expect(jul.balances.breaks.length).toBeGreaterThan(0);
    const b = await reconcile(w, { month: "2026-07", fingerprint: jul.fingerprint, acceptOpenItems: true });
    expect(b.body.error.code).toBe("BRS_STATEMENT_BREAK");
    expect(b.body.error.message).toMatch(/ — fix it on Bank, or reconcile with a note explaining it\.$/);
    expect((await reconcile(w, { month: "2026-07", fingerprint: jul.fingerprint, acceptOpenItems: true, acceptBreaks: true, note: "Bank corrected the balance on 14 Jul" })).status).toBe(201);
    // July is signed off closing at ₹6,100.00; August's typed closing works back to a different opening → a break to acknowledge.
    const aug2 = (await brs(w, "2026-08")).body.data;
    expect(aug2.balances.breaks.map((b: { text: string }) => b.text)).toContainEqual(expect.stringMatching(/^Last month was signed off with a closing balance of ₹6,100\.00, but the typed closing works back to an opening of ₹10,050\.00$/));
    expect(aug2.needsAck).toContain("statement_break");
  });

  it("S-6b a statement without a balance column but with an opening line: the closing is typed and checked against that opening, never 'agrees' unchecked (R→G)", async () => {
    await importFile(w, statement([{ date: "2026-05-01", narr: "NEFT CR MAY ONE", cr: R(1000) }, { date: "2026-05-31", narr: "ATM MAY", dr: R(300) }], { opening: R(5000), balance: false, openingRow: true }), "may.csv");
    const st = await prisma.salesBankStatement.findFirstOrThrow({ where: { fileName: "may.csv" } });
    expect(st.openingBalancePaise).toBe(BigInt(R(5000)));
    expect(st.closingBalancePaise).toBeNull();
    const may = (await brs(w, "2026-05")).body.data;
    expect(may.balances).toMatchObject({ source: "unknown", closingPaise: null, agreesWith: null });
    expect(may.needsAck).toContain("typed_closing");
    const base = { month: "2026-05", fingerprint: may.fingerprint, acceptOpenItems: true };
    expect((await reconcile(w, base)).body.error.code).toBe("BRS_BALANCE_UNKNOWN");
    const slip = await reconcile(w, { ...base, typedClosingPaise: R(5800) });
    expect(slip.body.error.code).toBe("BRS_STATEMENT_BREAK");
    expect(slip.body.error.message).toMatch(/^may\.csv opens at ₹5,000\.00, but the typed closing works back to an opening of ₹5,100\.00/);
    const ok = await reconcile(w, { ...base, typedClosingPaise: R(5700) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(await prisma.salesBrsSignoff.findFirstOrThrow({ where: { month: "2026-05" } })).toMatchObject({ balanceSource: "typed", openingPaise: BigInt(R(5000)), closingPaise: BigInt(R(5700)) });
  });

  it("S-6c a receipt's line in another month marked as stored twice: the reconciled month changes and the receipt is an open item (R→G)", async () => {
    const { r44 } = await buildOctober(w);
    const v = (await brs(w)).body.data;
    expect((await reconcile(w, { fingerprint: v.fingerprint, acceptOpenItems: true })).status).toBe(201);
    await prisma.salesBankLine.update({ where: { id: (await lineByNarr("UPI CR FILMY 0044")).id }, data: { ignoreReason: "duplicate", ignoredAt: new Date() } });
    const after = (await brs(w)).body.data;
    expect(after.state).toBe("changed");
    expect(after.items.find((i: { key: string }) => i.key === `nc:${r44.id}`)).toMatchObject({ open: true, reason: { code: "ON_UNCOUNTED_LINE" } });
    expect(after.openItems.count).toBe(4);
  });

  it("S-6d a second account printed on invoices later does not re-attribute a signed-off month (R→G)", async () => {
    await buildOctober(w);
    const v = (await brs(w)).body.data;
    expect((await reconcile(w, { fingerprint: v.fingerprint, acceptOpenItems: true })).status).toBe(201);
    const hd = await api().post("/v1/sales/bank/accounts").set(auth(w.admin)).send({ companyKey: "dspl", label: "HDFC", bank: "hdfc", accountNumber: "50100123456789" });
    expect(hd.status, JSON.stringify(hd.body)).toBe(201);
    expect((await api().put("/v1/sales/settings/seller").set(auth(w.admin)).send({ ...SELLER, accountNumber: "50100123456789" })).status).toBe(200);
    const after = (await brs(w)).body.data;
    expect(after.state).toBe("reconciled");
    expect(after.defaultAccount).toMatchObject({ id: w.accountId });
    expect(after.items.find((i: { reason: { code: string } }) => i.reason.code === "CHEQUE_CLEARING")).toBeTruthy();
    const months = (await api().get(`/v1/sales/reconcile/bank/months?company=dspl&accountId=${w.accountId}`).set(auth(w.sales))).body.data.months;
    expect(months.find((m: { month: string }) => m.month === "2026-10").state).toBe("reconciled");
    // HDFC now holds an October statement, so as of October it is a candidate and, printed on invoices, the default —
    // October's sign-off still judges it with the account it froze.
    await importFile(w, statement([{ date: "2026-10-20", narr: "HDFC NEFT CR OCT", cr: R(10) }], { opening: R(100), account: "50100123456789" }), "hdfc-oct.csv", hd.body.data.id);
    const later = (await brs(w)).body.data;
    expect(later.state).toBe("reconciled");
    expect(later.defaultAccount).toMatchObject({ id: w.accountId });
    // September (HDFC had no statement then) keeps the old account; November, unsigned, follows the setting.
    const at = async (m: string) => (await api().get(`/v1/sales/reconcile/bank?company=dspl&accountId=${w.accountId}&month=${m}`).set(auth(w.sales))).body.data.defaultAccount;
    expect(await at("2026-09")).toMatchObject({ id: w.accountId, why: "only" });
    expect(await at("2026-11")).toMatchObject({ id: hd.body.data.id, why: "printed_on_invoices" });
  });

  it("S-7 concurrency: parallel reconciles give one 201 and one 200/409; a reconcile racing a bank confirm never 500s and the stored fingerprint stays honest", async () => {
    await buildOctober(w);
    const v = (await brs(w)).body.data;
    const [a, b] = await Promise.all([reconcile(w, { fingerprint: v.fingerprint, acceptOpenItems: true }), reconcile(w, { fingerprint: v.fingerprint, acceptOpenItems: true })]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(await prisma.salesBrsSignoff.count({ where: { month: "2026-10" } })).toBe(1);
    // Reopen, then race a reconcile against recording the unknown credit on Bank.
    await api().post("/v1/sales/reconcile/bank/reopen?company=dspl").set(auth(w.sales)).send({ accountId: w.accountId, month: "2026-10", reason: "racing test" });
    const fp = (await brs(w)).body.data.fingerprint;
    const line = await lineByNarr("NEFT CR UNKNOWN PAYER");
    const [rec, conf] = await Promise.all([
      reconcile(w, { fingerprint: fp, acceptOpenItems: true }),
      api().post(`/v1/sales/bank/lines/${line.id}/confirm`).set(auth(w.sales)).send({ clientId: w.kanara, amountPaise: R(40000), tdsPaise: 0, allocations: [] }),
    ]);
    await flushSalesBackground();
    expect([201, 409]).toContain(rec.status);
    expect(conf.status, JSON.stringify(conf.body)).toBe(201);
    if (rec.status === 201) {
      const so = await prisma.salesBrsSignoff.findFirstOrThrow({ where: { month: "2026-10", activeKey: { not: null } } });
      const live = (await brsFingerprints(prisma as never, { accountId: w.accountId, company: "dspl", firstMonth: "2026-10", lastMonth: "2026-10", defaultAccountId: w.accountId })).get("2026-10");
      const snapHasReceipt = !(so.snapshot as { items: Array<{ key: string }> }).items.some((i) => i.key === `line:${line.id}`);
      expect(so.fingerprint === live).toBe(snapHasReceipt);
    } else expect(rec.body.error.code).toBe("BRS_CHANGED");
  });

  it("S-8 debit narrations: Sales sees them redacted in JSON, PDF and CSV; Admin sees them (R→G)", async () => {
    await buildOctober(w);
    const asSales = (await brs(w)).body.data;
    expect(asSales.debits.lines.every((d: { narration: string; redacted: boolean }) => d.narration === "" && d.redacted)).toBe(true);
    const asAdmin = (await brs(w, "2026-10", w.admin)).body.data;
    expect(asAdmin.debits.lines.map((d: { narration: string }) => d.narration)).toContain("RENT OCTOBER");
    const csv = (t: string) => api().get(`/v1/sales/reconcile/bank/brs.csv?company=dspl&accountId=${w.accountId}&month=2026-10`).set(auth(t));
    expect((await csv(w.sales)).text).not.toContain("RENT OCTOBER");
    expect((await csv(w.admin)).text).toContain("RENT OCTOBER");
    const pdf = async (t: string) => pdfText((await api().get(`/v1/sales/reconcile/bank/brs.pdf?company=dspl&accountId=${w.accountId}&month=2026-10`).set(auth(t)).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on("data", (d: Buffer) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); })).body as Buffer);
    expect(await pdf(w.sales)).not.toContain("RENT OCTOBER");
    expect(await pdf(w.admin)).toContain("RENT OCTOBER");
    // A reconciled version keeps the narrations in its snapshot; Sales still gets them redacted.
    expect((await reconcile(w, { fingerprint: asSales.fingerprint, acceptOpenItems: true })).status).toBe(201);
    expect((await csv(w.sales)).text).not.toContain("RENT OCTOBER");
    expect((await csv(w.admin)).text).toContain("RENT OCTOBER");
  });

  it("S-9 BIGINT: a ₹3 crore opening and a ₹2.5 crore credit recorded as two receipts are exact", async () => {
    const a = await receipt(w, "2026-06-10", R(12500000));
    const b = await receipt(w, "2026-06-10", R(12500000), "upi", w.kanara);
    await importFile(w, statement([{ date: "2026-06-10", narr: "RTGS CR BIG PAYER", cr: R(25000000) }], { opening: R(30000000) }), "jun.csv");
    await link(w, "RTGS CR BIG PAYER", a.id);
    await link(w, "RTGS CR BIG PAYER", b.id);
    const v = (await brs(w, "2026-06")).body.data;
    expect(v.balances).toMatchObject({ openingPaise: R(30000000), creditsPaise: R(25000000), closingPaise: R(55000000) });
    expect(v.books.receiptsPaise).toBe(R(25000000));
    expect(v.ties).toBe(true);
    expect((await reconcile(w, { month: "2026-06", fingerprint: v.fingerprint, acceptCoverageGaps: true, note: "June statement covers the 10th only" })).status).toBe(201);
    expect((await prisma.salesBrsSignoff.findFirstOrThrow({ where: { month: "2026-06" } })).closingPaise).toBe(5_500_000_000n);
  });

  it("S-10 the live PDF starts %PDF and says NOT RECONCILED; the CSV ties to the view; the one-tap Link turns a CREDIT_FITS item into a matched credit", async () => {
    await buildOctober(w);
    const late = await receipt(w, "2026-10-27", R(40000), "bank_transfer", w.kanara);
    const v = (await brs(w)).body.data;
    const fit = v.items.find((i: { key: string }) => i.key === `nc:${late.id}`);
    expect(fit).toMatchObject({ reason: { code: "CREDIT_FITS" }, link: { paymentId: late.id } });
    const res = await api().get(`/v1/sales/reconcile/bank/brs.pdf?company=dspl&accountId=${w.accountId}&month=2026-10&inline=1`).set(auth(w.sales)).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on("data", (d: Buffer) => c.push(d)); r.on("end", () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect((res.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
    expect(pdfText(res.body as Buffer)).toContain("NOT RECONCILED");
    const csv = await api().get(`/v1/sales/reconcile/bank/brs.csv?company=dspl&accountId=${w.accountId}&month=2026-10`).set(auth(w.sales));
    expect(csv.headers["content-disposition"]).toContain(`brs-dspl-8788-2026-10.csv`);
    const rows = csv.text.replace(/^﻿/, "").split("\r\n");
    expect(rows).toContain("Credits,633500.40");
    expect(rows).toContain("Agrees,yes");
    expect(rows.filter((r) => /^(not_credited|credited_other_month|unmatched|ignored|rounding|over_matched|duplicate),/.test(r))).toHaveLength(v.items.length);
    // One tap.
    const linked = await api().post(`/v1/sales/bank/lines/${fit.link.lineId}/link`).set(auth(w.sales)).send({ paymentId: late.id });
    expect(linked.status).toBe(200);
    await flushSalesBackground();
    const after = (await brs(w)).body.data;
    expect(after.items.some((i: { key: string }) => i.key === `nc:${late.id}` || i.key === `line:${fit.link.lineId}`)).toBe(false);
    expect(after.ties).toBe(true);
  });

  it("S-11 GET, reconcile and reopen change no bank line, receipt or money table", async () => {
    await buildOctober(w);
    await flushSalesBackground();
    const snap = await moneySnapshot();
    const v = (await brs(w)).body.data;
    await api().get(`/v1/sales/reconcile/bank/months?company=dspl`).set(auth(w.sales));
    expect(await moneySnapshot()).toEqual(snap);
    expect((await reconcile(w, { fingerprint: v.fingerprint, acceptOpenItems: true })).status).toBe(201);
    await api().get(`/v1/sales/reconcile/bank/brs.pdf?company=dspl&accountId=${w.accountId}&month=2026-10`).set(auth(w.sales));
    await api().get(`/v1/sales/reconcile/bank/brs.csv?company=dspl&accountId=${w.accountId}&month=2026-10`).set(auth(w.sales));
    expect((await api().post("/v1/sales/reconcile/bank/reopen?company=dspl").set(auth(w.sales)).send({ accountId: w.accountId, month: "2026-10", reason: "checking" })).status).toBe(200);
    expect(await moneySnapshot()).toEqual(snap);
  });

  it("S-12 another company's account → 409 COMPANY_MISMATCH; Viewer reads but cannot reconcile; the kill switch stops sign-offs only", async () => {
    await buildOctober(w);
    const dm = await api().post("/v1/sales/bank/accounts").set(auth(w.admin)).send({ companyKey: "dmpl", label: "ICICI", bank: "icici", accountNumber: "123456784421" });
    expect(dm.status, JSON.stringify(dm.body)).toBe(201);
    const mis = await api().get(`/v1/sales/reconcile/bank?company=dspl&accountId=${dm.body.data.id}&month=2026-10`).set(auth(w.sales));
    expect(mis.status).toBe(409);
    expect(mis.body.error).toMatchObject({ code: "COMPANY_MISMATCH", message: "This belongs to Dashmani Media Private Limited — switch company at the top." });
    const v = await brs(w, "2026-10", w.viewer);
    expect(v.status).toBe(200);
    expect((await api().get(`/v1/sales/reconcile/bank/months?company=dspl`).set(auth(w.viewer))).status).toBe(200);
    expect((await reconcile(w, { fingerprint: v.body.data.fingerprint, acceptOpenItems: true }, w.viewer)).status).toBe(403);
    vi.stubEnv("SALES_RECONCILE_ENABLED", "0");
    expect((await reconcile(w, { fingerprint: v.body.data.fingerprint, acceptOpenItems: true })).status).toBe(503);
    expect((await api().post("/v1/sales/reconcile/bank/reopen?company=dspl").set(auth(w.sales)).send({ accountId: w.accountId, month: "2026-10", reason: "x y z" })).body.error.code).toBe("RECONCILE_OFF");
    expect((await brs(w)).status).toBe(200);
  });
});
