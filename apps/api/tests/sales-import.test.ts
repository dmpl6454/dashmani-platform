/**
 * Swipe import (spec-import §8, T-14–T-38): upload → check → apply → undo through the real API.
 * Fixtures are dated relative to today's financial year so the file never ages into a different
 * series. The seller mirrors prod: Mumbai principal INV/4 digits, Gurugram branch INV/3 digits.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import zlib from "zlib";
import request from "supertest";
import { prisma } from "@dashmani/db";
import { financialYear, todayIST } from "@dashmani/shared";

const sent: Array<{ to: string; cc?: string; subject: string; attachments?: Array<{ filename: string; content: Buffer }> }> = [];
vi.mock("../src/services/email.service", async (orig) => {
  const real = await orig<typeof import("../src/services/email.service")>();
  return { ...real, sendEmail: vi.fn(async (o: (typeof sent)[number]) => { sent.push(o); return { messageId: "test" }; }) };
});

import app from "../src/app";
import { flushSalesBackground } from "../src/services/sales/common";
import { rerunReconcile, setImportInvoiceHookForTests } from "../src/services/sales/imports.service";
import { setIrpProviderForTests } from "../src/services/sales/irp/provider";
import { MockIrp } from "../src/services/sales/irp/mock";
import { UPLOAD_DIR_PATH } from "../src/middleware/upload";
import { createTestRole, createTestUser, generateClientToken, generateToken } from "./helpers";

const SELLER = {
  legalName: "Digital Sukoon Private Limited", gstin: "27AAKCD3352K1ZF", pan: "AAKCD3352K",
  addressLine1: "702, Parinee I, Andheri West", city: "Mumbai", state: "Maharashtra", stateCode: "27", pincode: "400053",
  invoicePrefix: "INV", creditNotePrefix: "CN", serialDigits: 4, email: "accounts@ds.test",
  branches: [{ label: "Gurugram", gstin: "06AAKCD3352K1ZJ", addressLine1: "Hunch Circle, Sector 29", city: "Gurugram", pincode: "122001", invoicePrefix: "INV", creditNotePrefix: "CNHR", serialDigits: 3 }],
};
const DM_SELLER = {
  legalName: "Dashmani Media Private Limited", gstin: "27AAJCD7425L1Z8", pan: "AAJCD7425L", addressLine1: "Off-702, Parinee I", city: "Mumbai", state: "Maharashtra",
  stateCode: "27", pincode: "400053", invoicePrefix: "DM", creditNotePrefix: "DMCN", quotePrefix: "DMQ", orderPrefix: "DMSO", receiptPrefix: "DMRC",
};
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

// ── Dates relative to today's financial year ──
const today = todayIST();
const FY = financialYear(today);
const CUR = FY.short; // e.g. 26-27
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const CUR_DAY = (() => { const d = addDays(today, -10); return d < FY.startDay ? FY.startDay : d; })();
const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

const HEAD = "Invoice Number,Invoice Date,Due Date,Customer Name,Customer GSTIN,Place of Supply,Item,HSN/SAC,Qty,Rate,Taxable Value,CGST,SGST,IGST,Total,Amount Paid,TDS,Balance,Status,PO Number,Notes";
const q = (s: string) => (s.includes(",") ? `"${s}"` : s);
const line = (cells: string[]) => cells.map(q).join(",");
/** §4.16 with the 2026-27 rows moved into today's financial year. `cgst059` lets T-17 change Swipe's own per-line tax. */
function worked(o: { cgst059?: string } = {}) {
  const c = o.cgst059 ?? "5,611.10";
  return [
    "Swipe - Sales Report,,,", "Generated on 05-11-2026,,,", HEAD,
    line(["INV/24-25/0102", "12/06/2024", "27/06/2024", "Filmy Brands Pvt. Ltd.", "27AAPFU0939F1ZV", "27-Maharashtra", "Instagram reel", "998365", "1", "1,00,000.00", "1,00,000.00", "9,000.00", "9,000.00", "0", "1,18,000.00", "1,08,000.00", "10,000.00", "0.00", "Paid", "PO-77", ""]),
    line([`INV/${CUR}/059`, dmy(CUR_DAY), dmy(addDays(CUR_DAY, 15)), "Hunch Foods LLP", "06AAXFH1234K1Z3", "06-Haryana", "Reel package", "998365", "2", "25,000.00", "50,000.00", c, c, "0", "73,568.00", "0", "0", "73,568.00", "Unpaid", "", ""]),
    line([`INV/${CUR}/059`, dmy(CUR_DAY), dmy(addDays(CUR_DAY, 15)), "Hunch Foods LLP", "06AAXFH1234K1Z3", "06-Haryana", "Story add-on", "998365", "1", "12,345.50", "12,345.50", c, c, "0", "73,568.00", "0", "0", "73,568.00", "Unpaid", "", ""]),
    line([`INV/${CUR}/0012`, dmy(CUR_DAY), dmy(addDays(CUR_DAY, 15)), "Saffron Media Pvt Ltd", "29AAGCS5678L1ZH", "29-Karnataka", "YouTube integration", "998365", "1", "40,000.00", "40,000.00", "0", "0", "7,200.00", "47,200.00", "46,400.00", "800.00", "0.00", "Paid", "", ""]),
  ].join("\r\n");
}
/** A one-row invoice in the same layout. */
const oneRow = (o: { no: string; date?: string; name?: string; gstin?: string; pos?: string; taxable: string; cgst?: string; sgst?: string; igst?: string; total: string; paid?: string; tds?: string; bal?: string; status?: string }) =>
  line([o.no, o.date ?? "12/06/2024", "", o.name ?? "Filmy Brands Pvt. Ltd.", o.gstin ?? "27AAPFU0939F1ZV", o.pos ?? "27", "Reel", "998365", "1", o.taxable, o.taxable, o.cgst ?? "0", o.sgst ?? "0", o.igst ?? "0", o.total, o.paid ?? "0", o.tds ?? "0", o.bal ?? "", o.status ?? "", "", ""]);
const csvOf = (rows: string[]) => [HEAD, ...rows].join("\r\n");

/** Every text run of a pdfkit PDF (standard fonts write hex strings inside Flate streams). */
function pdfText(buf: Buffer): string {
  const s = buf.toString("latin1");
  let out = "";
  const re = /stream\r?\n([\s\S]*?)endstream/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    let body: string;
    try { body = zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1"); } catch { continue; }
    for (const h of body.matchAll(/<([0-9a-fA-F]+)>/g)) out += Buffer.from(h[1], "hex").toString("latin1");
    out += "\n";
  }
  return out;
}
const binary = (res: NodeJS.ReadableStream, cb: (e: Error | null, b: Buffer) => void) => { const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks))); };

describe("Swipe import", () => {
  let salesToken: string;
  let adminToken: string;
  let employeeToken: string;
  let clientToken: string;
  const C: Record<string, string> = {};

  beforeEach(async () => {
    sent.length = 0;
    setIrpProviderForTests(new MockIrp());
    await prisma.systemSetting.deleteMany({ where: { key: { startsWith: "sales.seller" } } });
    await createTestRole("Sales", ["view", "create", "edit", "export", "manage"].map((action) => ({ resource: "sales", action, scope: "global" })));
    await createTestRole("Admin", ["view", "manage", "approve"].map((action) => ({ resource: "sales", action, scope: "global" })));
    await createTestRole("Employee", [{ resource: "tasks", action: "view", scope: "own" }]);
    const s = await createTestUser({ roleNames: ["Sales"] });
    const a = await createTestUser({ roleNames: ["Admin"] });
    const e = await createTestUser({ roleNames: ["Employee"] });
    salesToken = generateToken(s.id, s.email, ["Sales"]);
    adminToken = generateToken(a.id, a.email, ["Admin"]);
    employeeToken = generateToken(e.id, e.email, ["Employee"]);
    const filmy = await prisma.client.create({ data: { companyName: "Filmy Brands", contactName: "Riya", email: "riya@filmy.test", passwordHash: "x" } });
    await prisma.clientBillingProfile.create({ data: { clientId: filmy.id, legalName: "Filmy Brands Private Limited", gstin: "27AAPFU0939F1ZV", pan: "AAPFU0939F", stateCode: "27", state: "Maharashtra", addressLine1: "Bandra West", city: "Mumbai", pincode: "400050" } });
    const saffron = await prisma.client.create({ data: { companyName: "Saffron Media", contactName: "Sam", email: "sam@saffron.test", passwordHash: "x" } });
    C.filmy = filmy.id;
    C.saffron = saffron.id;
    clientToken = generateClientToken(filmy.id, filmy.email);
    expect((await request(app).put("/v1/sales/settings/seller").set(auth(adminToken)).send(SELLER)).status).toBe(200);
    await prisma.salesSequence.createMany({ data: [{ key: `invoice:${FY.label}`, next: 16 }, { key: `invoice@06AAKCD3352K1ZJ:${FY.label}`, next: 60 }] });
  });
  afterEach(async () => {
    setImportInvoiceHookForTests(null);
    setIrpProviderForTests(null);
    vi.unstubAllEnvs();
    await flushSalesBackground();
  });

  const upload = (token: string, csv: string | Buffer, name = "swipe.csv", company: string | null = "dspl", extra: Record<string, string> = {}) => {
    let r = request(app).post("/v1/sales/imports").set(auth(token)).attach("file", typeof csv === "string" ? Buffer.from(csv) : csv, name);
    if (company) r = r.field("company", company);
    for (const [k, v] of Object.entries(extra)) r = r.field(k, v);
    return r;
  };
  async function uploaded(csv: string, company = "dspl", extra: Record<string, string> = {}) {
    const r = await upload(salesToken, csv, "swipe.csv", company, extra);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.data;
  }
  const getImport = async (id: string) => (await request(app).get(`/v1/sales/imports/${id}`).set(auth(salesToken))).body.data;
  const apply = (id: string, body: Record<string, unknown>) => request(app).post(`/v1/sales/imports/${id}/apply`).set(auth(adminToken)).send(body);
  async function applied(csv: string, opts: { acceptWarnings?: boolean; confirmLiveSeries?: boolean; company?: string } = {}) {
    const imp = await uploaded(csv, opts.company ?? "dspl");
    const r = await apply(imp.id, { planHash: imp.planHash, acceptWarnings: opts.acceptWarnings ?? true, confirmLiveSeries: opts.confirmLiveSeries ?? false });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    await flushSalesBackground();
    const done = await getImport(imp.id);
    expect(done.status, JSON.stringify(done.lastError)).toBe("applied");
    return done;
  }
  const seq = async (key: string) => (await prisma.salesSequence.findUnique({ where: { key } }))?.next ?? null;
  const counts = async () => ({
    invoices: await prisma.salesInvoice.count(), payments: await prisma.salesPayment.count(), allocations: await prisma.salesPaymentAllocation.count(),
    clients: await prisma.client.count(), profiles: await prisma.clientBillingProfile.count(),
    seqs: (await prisma.salesSequence.findMany({ orderBy: { key: "asc" } })).map((s) => `${s.key}=${s.next}`).join(","),
  });

  it("T-14 RBAC: Sales checks, only an Admin imports; Employee and client tokens are refused", async () => {
    const imp = await uploaded(worked());
    expect((await request(app).put(`/v1/sales/imports/${imp.id}/mapping`).set(auth(salesToken)).send({ mapping: imp.mapping, options: imp.options })).status).toBe(200);
    expect((await request(app).put(`/v1/sales/imports/${imp.id}/clients`).set(auth(salesToken)).send({ choices: [{ groupKey: "gstin:06AAXFH1234K1Z3", clientId: "new" }] })).status).toBe(200);
    const chk = await request(app).post(`/v1/sales/imports/${imp.id}/check`).set(auth(salesToken));
    expect(chk.status).toBe(200);
    expect((await request(app).post(`/v1/sales/imports/${imp.id}/apply`).set(auth(salesToken)).send({ planHash: chk.body.data.planHash })).status).toBe(403);
    expect((await request(app).get("/v1/sales/imports").set(auth(employeeToken))).status).toBe(403);
    expect((await upload(employeeToken, worked())).status).toBe(403);
    expect((await request(app).get("/v1/sales/imports").set(auth(clientToken))).status).toBe(403);
    expect((await apply(imp.id, { planHash: chk.body.data.planHash })).status).toBe(202);
    await flushSalesBackground();
  });

  it("T-15 upload writes nothing but the import: no invoices, receipts, clients, sequences or files", async () => {
    const before = await counts();
    const filesBefore = fs.existsSync(UPLOAD_DIR_PATH) ? (fs.readdirSync(UPLOAD_DIR_PATH, { recursive: true }) as string[]).sort() : [];
    const csv = worked();
    const imp = await uploaded(csv);
    await request(app).put(`/v1/sales/imports/${imp.id}/mapping`).set(auth(salesToken)).send({ mapping: imp.mapping, options: { ...imp.options, dateOrder: "dmy" } });
    await request(app).post(`/v1/sales/imports/${imp.id}/check`).set(auth(salesToken));
    expect(await counts()).toEqual(before);
    const filesAfter = fs.existsSync(UPLOAD_DIR_PATH) ? (fs.readdirSync(UPLOAD_DIR_PATH, { recursive: true }) as string[]).sort() : [];
    expect(filesAfter).toEqual(filesBefore);
    const { createHash } = await import("crypto");
    expect(imp.file.sha256).toBe(createHash("sha256").update(Buffer.from(csv)).digest("hex"));
    expect(imp.grid).toBeUndefined(); // the grid never leaves the server (columns carry 3 samples each)
    expect(JSON.stringify(imp)).not.toContain("YouTube integration"); // a 4th value of a column is in no sample
    const big = await upload(salesToken, Buffer.alloc(6 * 1024 * 1024, 65), "big.csv");
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe("FILE_TOO_LARGE");
    const html = await upload(salesToken, "<html><table><tr><td>Invoice</td></tr></table></html>", "x.csv");
    expect(html.status).toBe(422);
    expect(html.body.error.code).toBe("FILE_UNREADABLE");
    const exe = await upload(salesToken, "MZ", "x.exe");
    expect(exe.status).toBe(400);
    expect(exe.body.error.code).toBe("INVALID_FILE_TYPE");
    const noCompany = await upload(salesToken, worked(), "swipe.csv", null);
    expect(noCompany.status).toBe(400);
    expect(noCompany.body.error.code).toBe("VALIDATION_ERROR");
    const noHead = await upload(salesToken, "a,b\n1,2\n", "x.csv");
    expect(noHead.body.error.code).toBe("NO_HEADER_ROW");
  });

  it("T-16 the check report on the worked example, paginated", async () => {
    const imp = await uploaded(worked());
    expect(imp.status).toBe("draft");
    expect(imp.summary.outcomes).toMatchObject({ ready: 3, error: 0, warning: 0 });
    expect(imp.summary.notices.map((n: { code: string }) => n.code)).toContain("PAID_TDS_DETECTED");
    expect(imp.counts).toMatchObject({ found: 3, ready: 3 });
    const regs = imp.summary.byRegistration.map((r: { sequenceKey: string; nextBefore: string; nextAfter: string }) => [r.sequenceKey, r.nextBefore, r.nextAfter]);
    expect(regs).toEqual(expect.arrayContaining([
      ["invoice:2024-25", "INV/24-25/0001", "INV/24-25/0103"],
      [`invoice@06AAKCD3352K1ZJ:${FY.label}`, `INV/${CUR}/060`, `INV/${CUR}/060`],
      [`invoice:${FY.label}`, `INV/${CUR}/0016`, `INV/${CUR}/0016`],
    ]));
    const groups = Object.fromEntries(imp.summary.clientGroups.map((g: { groupKey: string; decision: unknown }) => [g.groupKey, g.decision]));
    expect(groups["gstin:27AAPFU0939F1ZV"]).toMatchObject({ action: "match", clientId: C.filmy, by: "gstin" });
    expect(groups["gstin:29AAGCS5678L1ZH"]).toMatchObject({ action: "match", clientId: C.saffron, by: "name" });
    expect(groups["gstin:06AAXFH1234K1Z3"]).toMatchObject({ action: "create" });
    expect(imp.columns.length).toBe(21);
    expect(imp.columns[0]).toMatchObject({ header: "Invoice Number", samples: ["INV/24-25/0102", `INV/${CUR}/059`, `INV/${CUR}/059`] });
    const page = await request(app).get(`/v1/sales/imports/${imp.id}/invoices?outcome=ready&limit=2`).set(auth(salesToken));
    expect(page.body.data.total).toBe(3);
    expect(page.body.data.rows.map((r: { number: string }) => r.number)).toEqual(["INV/24-25/0102", `INV/${CUR}/0012`]);
    const next = await request(app).get(`/v1/sales/imports/${imp.id}/invoices?outcome=ready&limit=2&from=2`).set(auth(salesToken));
    expect(next.body.data.rows.map((r: { number: string }) => r.number)).toEqual([`INV/${CUR}/059`]);
    expect((await request(app).get(`/v1/sales/imports/${imp.id}/invoices?q=hunch`).set(auth(salesToken))).body.data.total).toBe(1);
  });

  it("T-17/T-18 imports Swipe's stated figures, original number and dates, snapshots and events", async () => {
    // Swipe truncated per line: CGST = SGST 5,611.09 where computeTotals would give 5,611.10 and +0.30.
    const done = await applied(worked({ cgst059: "5,611.09" }));
    expect(done.counts).toMatchObject({ imported: 3, payments: 2, clientsCreated: 1 });
    const inv = await prisma.salesInvoice.findFirstOrThrow({ where: { number: `INV/${CUR}/059` }, include: { items: { orderBy: { position: "asc" } } } });
    expect(inv).toMatchObject({ source: "swipe", importId: done.id, status: "issued", kind: "tax_invoice", taxMode: "intra", gstRateBp: 1800, cgstPaise: 561_109, sgstPaise: 561_109, roundOffPaise: 32, taxablePaise: 6_234_550, totalPaise: 7_356_800, terms: null, sellerGstin: "06AAKCD3352K1ZJ" });
    expect(inv.issueDate?.toISOString().slice(0, 10)).toBe(CUR_DAY);
    expect(inv.createdAt.toISOString()).toBe(`${CUR_DAY}T06:30:00.000Z`);
    expect(inv.issuedAt?.toISOString()).toBe(`${CUR_DAY}T06:30:00.000Z`);
    expect(inv.items.map((i) => [i.quantity, i.unitPricePaise, i.amountPaise])).toEqual([[2, 2_500_000, 5_000_000], [1, 1_234_550, 1_234_550]]);
    expect(inv.sellerSnapshot).toMatchObject({ gstin: "06AAKCD3352K1ZJ", city: "Gurugram", registration: "Gurugram", legalName: "Digital Sukoon Private Limited" });
    expect(inv.buyerSnapshot).toMatchObject({ gstin: "06AAXFH1234K1Z3", stateCode: "06", state: "Haryana" });
    expect(inv.amountInWords).toMatch(/Seventy[- ]Three Thousand/i);
    const a = await prisma.salesInvoice.findFirstOrThrow({ where: { number: "INV/24-25/0102" } });
    expect(a.sellerSnapshot).toMatchObject({ gstin: "27AAKCD3352K1ZF", city: "Mumbai" });
    expect(a.buyerSnapshot).toMatchObject({ gstin: "27AAPFU0939F1ZV", addressLine1: "Bandra West", legalName: "Filmy Brands Private Limited" });
    expect(a).toMatchObject({ poNumber: "PO-77", status: "paid", clientId: C.filmy });
    const ev = await prisma.salesEvent.findFirst({ where: { entityType: "invoice", entityId: inv.id, action: "imported" } });
    expect(ev?.note).toContain("Swipe import · swipe.csv");
    // The portal's invoice view says where it came from.
    const view = await request(app).get(`/v1/sales/invoices/${inv.id}`).set(auth(salesToken));
    expect(view.body.data).toMatchObject({ source: "swipe", importId: done.id, salesImport: { id: done.id, fileName: "swipe.csv" } });
    const list = await request(app).get(`/v1/sales/invoices?importId=${done.id}&status=all`).set(auth(salesToken));
    expect(list.body.data.length).toBe(3);
  });

  it("T-19 series: past FYs move past imported serials, live ones are left alone, cancelled ones still count, off-format never", async () => {
    await applied(worked());
    expect(await seq("invoice:2024-25")).toBe(103);
    expect(await seq(`invoice:${FY.label}`)).toBe(16);
    expect(await seq(`invoice@06AAKCD3352K1ZJ:${FY.label}`)).toBe(60);
    await applied(csvOf([
      oneRow({ no: "DS/23-24/7", date: "12/06/2023", taxable: "100", cgst: "9", sgst: "9", total: "118" }),
      oneRow({ no: "INV/23-24/0040", date: "12/07/2023", taxable: "100", cgst: "9", sgst: "9", total: "118", status: "Cancelled" }),
    ]));
    expect(await seq("invoice:2023-24")).toBe(41);
    const cancelled = await prisma.salesInvoice.findFirstOrThrow({ where: { number: "INV/23-24/0040" } });
    expect(cancelled).toMatchObject({ status: "cancelled", cancelReason: "Cancelled in Swipe" });
    expect(await prisma.salesPayment.count({ where: { allocations: { some: { invoiceId: cancelled.id } } } })).toBe(0);
  });

  it("T-20 a move of the live series needs the Admin's confirmation", async () => {
    const imp = await uploaded(csvOf([oneRow({ no: `INV/${CUR}/0020`, date: dmy(CUR_DAY), taxable: "100", cgst: "9", sgst: "9", total: "118" })]));
    expect(imp.summary.liveSeriesMoves).toEqual([{ label: `INV/${CUR} (Mumbai (27AAKCD3352K1ZF))`, from: `INV/${CUR}/0016`, to: `INV/${CUR}/0021` }]);
    const no = await apply(imp.id, { planHash: imp.planHash });
    expect(no.status).toBe(409);
    expect(no.body.error.code).toBe("LIVE_SERIES_NOT_CONFIRMED");
    expect(await seq(`invoice:${FY.label}`)).toBe(16);
    expect((await apply(imp.id, { planHash: imp.planHash, confirmLiveSeries: true })).status).toBe(202);
    await flushSalesBackground();
    expect(await seq(`invoice:${FY.label}`)).toBe(21);
  });

  it("T-21/T-22 a paid invoice gets one SW- receipt, settles through recomputeSettlement, and nothing is emailed or registered", async () => {
    const generate = vi.spyOn(MockIrp.prototype, "generate");
    await request(app).put("/v1/sales/settings/seller").set(auth(adminToken)).send({ ...SELLER, eInvoicing: { enabled: true, applicableFrom: "2017-07-01" } });
    await applied(worked());
    const p = await prisma.salesPayment.findFirstOrThrow({ where: { number: "SW-INV/24-25/0102" }, include: { allocations: true } });
    expect(p).toMatchObject({ mode: "bank_transfer", reference: "Swipe import", amountPaise: 10_800_000, tdsPaise: 1_000_000, status: "recorded" });
    expect(p.importId).not.toBeNull();
    expect(p.paidOn.toISOString().slice(0, 10)).toBe("2024-06-12");
    expect(p.allocations[0]).toMatchObject({ amountPaise: 10_800_000, tdsPaise: 1_000_000 });
    const inv = await prisma.salesInvoice.findFirstOrThrow({ where: { number: "INV/24-25/0102" } });
    expect(inv).toMatchObject({ status: "paid", paidPaise: 10_800_000, tdsPaise: 1_000_000 });
    expect(inv.paidAt?.toISOString()).toBe("2024-06-12T06:30:00.000Z");
    await flushSalesBackground();
    expect(sent).toEqual([]);
    expect(await prisma.salesEInvoice.count()).toBe(0);
    expect(generate).not.toHaveBeenCalled();
    generate.mockRestore();
  });

  it("T-23 the same file twice: every invoice is already in, nothing to import, nothing created twice", async () => {
    const first = await applied(worked());
    const before = await counts();
    const again = await uploaded(worked());
    expect(again.summary.outcomes).toMatchObject({ duplicate: 3, ready: 0 });
    expect(again.counts.ready).toBe(0);
    expect(again.summary.notices.map((n: { code: string }) => n.code)).toContain("SAME_FILE_IMPORTED");
    expect(again.sameFile.map((s: { id: string }) => s.id)).toContain(first.id);
    const rows = (await request(app).get(`/v1/sales/imports/${again.id}/invoices`).set(auth(salesToken))).body.data.rows;
    expect(rows.every((r: { issues: Array<{ code: string }> }) => r.issues.some((i) => i.code === "ALREADY_IMPORTED"))).toBe(true);
    const r = await apply(again.id, { planHash: again.planHash });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("NOTHING_TO_IMPORT");
    expect(await counts()).toEqual(before);
  });

  it("T-24 a number already in the portal: same bill is a duplicate, anything else an error, never overwritten", async () => {
    const mk = (companyKey: string, clientId: string, number: string, day: string, total: number) => prisma.salesInvoice.create({
      data: { companyKey, kind: "tax_invoice", clientId, number, status: "issued", issueDate: new Date(`${day}T00:00:00Z`), dueDate: new Date(`${day}T00:00:00Z`), taxMode: "intra", gstRateBp: 1800, subtotalPaise: total, taxablePaise: total, totalPaise: total, createdById: "x" },
    });
    await mk("dspl", C.filmy, `INV/${CUR}/0016`, CUR_DAY, 11_800);
    await mk("dspl", C.saffron, `INV/${CUR}/0017`, CUR_DAY, 11_800);
    await mk("dmpl", C.filmy, `INV/${CUR}/0018`, CUR_DAY, 11_800);
    const imp = await uploaded(csvOf([
      oneRow({ no: `INV/${CUR}/0016`, date: dmy(CUR_DAY), taxable: "100", cgst: "9", sgst: "9", total: "118" }),
      oneRow({ no: `INV/${CUR}/0017`, date: dmy(CUR_DAY), taxable: "100", cgst: "9", sgst: "9", total: "118" }),
      oneRow({ no: `INV/${CUR}/0018`, date: dmy(CUR_DAY), taxable: "100", cgst: "9", sgst: "9", total: "118" }),
    ]));
    const rows = (await request(app).get(`/v1/sales/imports/${imp.id}/invoices`).set(auth(salesToken))).body.data.rows as Array<{ number: string; outcome: string; issues: Array<{ code: string }> }>;
    const by = Object.fromEntries(rows.map((r) => [r.number, r]));
    expect(by[`INV/${CUR}/0016`].outcome).toBe("duplicate");
    expect(by[`INV/${CUR}/0016`].issues.map((i) => i.code)).toContain("IN_PORTAL");
    expect(by[`INV/${CUR}/0017`].issues.map((i) => i.code)).toContain("NUMBER_IN_PORTAL");
    expect(by[`INV/${CUR}/0018`].issues.map((i) => i.code)).toContain("NUMBER_IN_PORTAL");
    expect(by[`INV/${CUR}/0017`].outcome).toBe("error");
  });

  it("T-25 the plan handshake: a changed portal refuses the old hash and saves the fresh check; warnings and blockers refuse", async () => {
    const imp = await uploaded(worked());
    await prisma.salesInvoice.create({ data: { companyKey: "dspl", kind: "tax_invoice", clientId: C.saffron, number: "INV/24-25/0102", status: "issued", issueDate: new Date("2024-06-12T00:00:00Z"), taxMode: "intra", gstRateBp: 1800, totalPaise: 5, createdById: "x" } });
    const r = await apply(imp.id, { planHash: imp.planHash });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("PLAN_CHANGED");
    const fresh = await getImport(imp.id);
    expect(fresh.planHash).not.toBe(imp.planHash);
    expect(fresh.summary.outcomes.error).toBe(1);
    expect((await apply(imp.id, { planHash: fresh.planHash })).status).toBe(202);
    await flushSalesBackground();
    expect(await prisma.salesInvoice.count({ where: { source: "swipe" } })).toBe(2);

    // A warning must be acknowledged (a Gurugram serial with no other evidence → REGISTRATION_ASSUMED).
    const w = await uploaded(csvOf([oneRow({ no: "INV/23-24/061", date: "01/10/2023", gstin: "29AAGCS5678L1ZH", pos: "29", taxable: "100", igst: "18", total: "118" })]));
    expect(w.summary.outcomes.warning).toBe(1);
    const nw = await apply(w.id, { planHash: w.planHash });
    expect(nw.body.error.code).toBe("WARNINGS_NOT_ACCEPTED");
    // Two portal clients share a GSTIN → a person must choose → blocked.
    const twin = await prisma.client.create({ data: { companyName: "Filmy Twin", contactName: "T", email: "t@twin.test", passwordHash: "x" } });
    await prisma.clientBillingProfile.create({ data: { clientId: twin.id, legalName: "Filmy Twin", gstin: "27AAPFU0939F1ZV", stateCode: "27" } });
    const b = await uploaded(csvOf([oneRow({ no: "INV/22-23/0001", date: "01/10/2022", taxable: "100", cgst: "9", sgst: "9", total: "118" })]));
    expect(b.summary.blockers.map((x: { code: string }) => x.code)).toContain("CLIENTS_UNRESOLVED");
    const nb = await apply(b.id, { planHash: b.planHash });
    expect(nb.body.error.code).toBe("IMPORT_BLOCKED");
    // Choosing the client clears it, and the choice survives "check again" (T-27).
    const chosen = await request(app).put(`/v1/sales/imports/${b.id}/clients`).set(auth(salesToken)).send({ choices: [{ groupKey: "gstin:27AAPFU0939F1ZV", clientId: twin.id }] });
    expect(chosen.body.data.summary.blockers).toEqual([]);
    const again = await request(app).post(`/v1/sales/imports/${b.id}/check`).set(auth(salesToken));
    expect(again.body.data.summary.clientGroups[0].decision).toMatchObject({ action: "match", clientId: twin.id, by: "user" });
  });

  it("T-26 resume after a crash: nothing twice; a stale run is resumable, a fresh one busy; two applies at once → one wins", async () => {
    const imp = await uploaded(worked());
    setImportInvoiceHookForTests((n) => { if (n === 2) throw new Error("simulated crash"); });
    expect((await apply(imp.id, { planHash: imp.planHash })).status).toBe(202);
    await flushSalesBackground();
    const failed = await getImport(imp.id);
    expect(failed.status).toBe("failed");
    expect(failed.lastError).toContain("simulated crash");
    expect(failed.counts.imported).toBe(2);
    setImportInvoiceHookForTests(null);
    const before = await prisma.client.count();
    expect((await apply(imp.id, { planHash: failed.planHash })).status).toBe(202);
    await flushSalesBackground();
    const done = await getImport(imp.id);
    expect(done.status).toBe("applied");
    expect(done.counts).toMatchObject({ imported: 3, payments: 2, clientsCreated: 1 });
    expect(await prisma.client.count()).toBe(before);
    for (const n of ["INV/24-25/0102", `INV/${CUR}/059`, `INV/${CUR}/0012`]) expect(await prisma.salesInvoice.count({ where: { number: n } })).toBe(1);
    expect(await prisma.salesPayment.count({ where: { importId: imp.id } })).toBe(2);

    // Busy vs stale.
    const other = await uploaded(csvOf([oneRow({ no: "INV/22-23/0002", date: "01/10/2022", taxable: "100", cgst: "9", sgst: "9", total: "118" })]));
    await prisma.$executeRaw`UPDATE sales_imports SET status = 'applying', updated_at = (now() AT TIME ZONE 'UTC') WHERE id = ${other.id}`;
    const busy = await apply(other.id, { planHash: other.planHash });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe("IMPORT_BUSY");
    await prisma.$executeRaw`UPDATE sales_imports SET updated_at = (now() AT TIME ZONE 'UTC') - interval '3 minutes' WHERE id = ${other.id}`;
    expect((await getImport(other.id)).stale).toBe(true);
    expect((await apply(other.id, { planHash: other.planHash, acceptWarnings: true })).status).toBe(202);
    await flushSalesBackground();
    expect((await getImport(other.id)).status).toBe("applied");

    // Two applies at once.
    const race = await uploaded(csvOf([oneRow({ no: "INV/22-23/0003", date: "01/10/2022", taxable: "100", cgst: "9", sgst: "9", total: "118" })]));
    const [x, y] = await Promise.all([apply(race.id, { planHash: race.planHash, acceptWarnings: true }), apply(race.id, { planHash: race.planHash, acceptWarnings: true })]);
    expect([x.status, y.status].sort()).toEqual([202, 409]);
    await flushSalesBackground();
    expect(await prisma.salesInvoice.count({ where: { number: "INV/22-23/0003" } })).toBe(1);
  });

  it("T-27 clients: a new one from the file, a missing profile filled, an existing profile untouched", async () => {
    const filmyBefore = await prisma.clientBillingProfile.findUniqueOrThrow({ where: { clientId: C.filmy } });
    await applied(worked());
    const hunch = await prisma.client.findFirstOrThrow({ where: { companyName: "Hunch Foods LLP" }, include: { billingProfile: true } });
    expect(hunch.email).toMatch(/^hunch-foods-llp-[0-9a-f]{4}@imported\.invalid$/);
    expect(hunch.billingProfile).toMatchObject({ gstin: "06AAXFH1234K1Z3", stateCode: "06", state: "Haryana", pan: "AAXFH1234K" });
    expect(await prisma.salesEvent.count({ where: { entityType: "client", entityId: hunch.id, action: "client_imported" } })).toBe(1);
    const saffron = await prisma.clientBillingProfile.findUniqueOrThrow({ where: { clientId: C.saffron } });
    expect(saffron).toMatchObject({ gstin: "29AAGCS5678L1ZH", stateCode: "29" });
    expect(await prisma.salesEvent.count({ where: { entityType: "client", entityId: C.saffron, action: "billing_profile_imported" } })).toBe(1);
    expect(await prisma.clientBillingProfile.findUniqueOrThrow({ where: { clientId: C.filmy } })).toEqual(filmyBefore);
  });

  it("T-28 an imported invoice is locked: no edit, no cancel; credit notes, receipts and a manual email still work", async () => {
    await applied(worked());
    const inv = await prisma.salesInvoice.findFirstOrThrow({ where: { number: `INV/${CUR}/059` } });
    const put = await request(app).put(`/v1/sales/invoices/${inv.id}`).set(auth(salesToken)).send({ clientId: inv.clientId, items: [{ description: "x", quantity: 1, unitPricePaise: 100 }] });
    expect(put.status).toBe(409);
    expect(put.body.error).toMatchObject({ code: "INVOICE_LOCKED", message: expect.stringContaining("Imported from Swipe") });
    const cancel = await request(app).post(`/v1/sales/invoices/${inv.id}/cancel`).set(auth(salesToken)).send({ reason: "wrong" });
    expect(cancel.status).toBe(409);
    expect(cancel.body.error.code).toBe("INVOICE_IMPORTED");
    const cn = await request(app).post("/v1/sales/credit-notes").set(auth(salesToken)).send({ invoiceId: inv.id, reason: "Story not run", taxablePaise: 1_234_550 });
    expect(cn.status, JSON.stringify(cn.body)).toBe(201);
    const rc = await request(app).post("/v1/sales/payments").set(auth(salesToken)).send({ clientId: inv.clientId, amountPaise: 100_000, tdsPaise: 0, mode: "bank_transfer", paidOn: today, allocations: [{ invoiceId: inv.id, amountPaise: 100_000, tdsPaise: 0 }] });
    expect(rc.status, JSON.stringify(rc.body)).toBe(201);
    await flushSalesBackground();
    expect(sent).toEqual([]); // an imported invoice is never emailed automatically
    const manual = await request(app).post(`/v1/sales/invoices/${inv.id}/email`).set(auth(salesToken)).send({});
    expect(manual.status, JSON.stringify(manual.body)).toBe(200);
    await flushSalesBackground();
    expect(sent.length).toBe(1);
    const pdf = sent[0].attachments?.[0]?.content as Buffer;
    expect(pdfText(pdf)).toContain("reproduced from Swipe");
  });

  it("T-29 undo removes what the import made and keeps clients and series; anything else touching it blocks", async () => {
    const done = await applied(worked());
    expect(done.undo).toEqual({ allowed: true, blockedBy: null });
    const inv = await prisma.salesInvoice.findFirstOrThrow({ where: { number: `INV/${CUR}/059` } });
    // (a) a portal receipt on an imported invoice
    const rc = await request(app).post("/v1/sales/payments").set(auth(salesToken)).send({ clientId: inv.clientId, amountPaise: 100_000, tdsPaise: 0, mode: "upi", paidOn: today, allocations: [{ invoiceId: inv.id, amountPaise: 100_000, tdsPaise: 0 }] });
    expect(rc.status).toBe(201);
    const undo = (reason = "Wrong file") => request(app).post(`/v1/sales/imports/${done.id}/undo`).set(auth(adminToken)).send({ reason });
    let r = await undo();
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: "UNDO_BLOCKED", message: expect.stringContaining(`has receipt ${rc.body.data.number}`) });
    expect((await getImport(done.id)).undo.allowed).toBe(false);
    // … still blocked once that receipt is voided
    expect((await request(app).post(`/v1/sales/payments/${rc.body.data.id}/void`).set(auth(salesToken)).send({ reason: "typo" })).status).toBe(200);
    expect((await undo()).body.error.code).toBe("UNDO_BLOCKED");
    await prisma.salesPayment.delete({ where: { id: rc.body.data.id } });
    // (b) a cancelled credit note still holds it
    const cn = await request(app).post("/v1/sales/credit-notes").set(auth(salesToken)).send({ invoiceId: inv.id, reason: "Story not run", taxablePaise: 100_000 });
    expect(cn.status, JSON.stringify(cn.body)).toBe(201);
    expect((await request(app).post(`/v1/sales/credit-notes/${cn.body.data.id}/cancel`).set(auth(salesToken)).send({ reason: "Raised by mistake" })).status).toBe(200);
    expect((await undo()).body.error.message).toContain("credit note");
    await prisma.salesCreditNote.delete({ where: { id: cn.body.data.id } });
    // (d) a refund on an import receipt
    const sw = await prisma.salesPayment.findFirstOrThrow({ where: { number: "SW-INV/24-25/0102" } });
    const refund = await prisma.salesRefund.create({ data: { number: "RF/x/1", paymentId: sw.id, clientId: sw.clientId, amountPaise: 1, refundedOn: new Date(), mode: "upi", createdById: "x" } });
    expect((await undo()).body.error.message).toContain("has a refund");
    await prisma.salesRefund.delete({ where: { id: refund.id } });
    // nothing blocks now: undo
    const before = { clients: await prisma.client.count(), seqs: await prisma.salesSequence.findMany({ orderBy: { key: "asc" } }) };
    r = await undo("Imported the wrong year");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ status: "undone", undoReason: "Imported the wrong year" });
    expect(await prisma.salesInvoice.count({ where: { importId: done.id } })).toBe(0);
    expect(await prisma.salesPayment.count({ where: { importId: done.id } })).toBe(0);
    expect(await prisma.salesInvoiceItem.count({ where: { invoiceId: inv.id } })).toBe(0);
    expect(await prisma.client.count()).toBe(before.clients);
    expect(await prisma.salesSequence.findMany({ orderBy: { key: "asc" } })).toEqual(before.seqs);
    const trail = await prisma.salesImportInvoice.findMany({ where: { importId: done.id } });
    expect(trail.every((t) => t.outcome === "imported" && t.invoiceId)).toBe(true);
    // A receipt for an undone invoice finds nothing.
    const late = await request(app).post("/v1/sales/payments").set(auth(salesToken)).send({ clientId: inv.clientId, amountPaise: 100, tdsPaise: 0, mode: "upi", paidOn: today, allocations: [{ invoiceId: inv.id, amountPaise: 100, tdsPaise: 0 }] });
    expect(late.status).toBe(404);
    expect((await undo()).body.error.code).toBe("IMPORT_NOT_APPLIED");
  });

  it("T-32 a cancelled Swipe invoice comes in cancelled with no receipt and outside the dashboard; money on one is an error", async () => {
    const done = await applied(csvOf([oneRow({ no: `INV/${CUR}/0005`, date: dmy(CUR_DAY), taxable: "100", cgst: "9", sgst: "9", total: "118", status: "Cancelled" })]), { confirmLiveSeries: true });
    const inv = await prisma.salesInvoice.findFirstOrThrow({ where: { importId: done.id } });
    expect(inv).toMatchObject({ status: "cancelled", cancelReason: "Cancelled in Swipe" });
    expect(inv.cancelledAt?.toISOString()).toBe(`${CUR_DAY}T06:30:00.000Z`);
    const dash = await request(app).get("/v1/sales/dashboard?company=dspl").set(auth(salesToken));
    expect(dash.body.data.invoicedFyPaise).toBe(0);
    const bad = await uploaded(csvOf([oneRow({ no: "INV/22-23/0009", date: "01/10/2022", taxable: "100", cgst: "9", sgst: "9", total: "118", paid: "118", status: "Cancelled" })]));
    const rows = (await request(app).get(`/v1/sales/imports/${bad.id}/invoices`).set(auth(salesToken))).body.data.rows;
    expect(rows[0].issues.map((i: { code: string }) => i.code)).toContain("PAID_ON_CANCELLED");
  });

  it("T-33 company isolation: Digital Sukoon's file under Dashmani Media is refused; a Dashmani Media import keeps to its books", async () => {
    expect((await request(app).put("/v1/sales/settings/seller?company=dmpl").set(auth(adminToken)).send(DM_SELLER)).status).toBe(200);
    const wrong = await uploaded(worked(), "dmpl");
    const rows = (await request(app).get(`/v1/sales/imports/${wrong.id}/invoices?outcome=error`).set(auth(salesToken))).body.data.rows;
    expect(rows.find((r: { number: string }) => r.number === "INV/24-25/0102").issues.map((i: { code: string }) => i.code)).toContain("OTHER_COMPANY");
    const dm = await applied(csvOf([oneRow({ no: "DM/24-25/0005", taxable: "100", cgst: "9", sgst: "9", total: "118", paid: "118", bal: "0" })]), { company: "dmpl" });
    const inv = await prisma.salesInvoice.findFirstOrThrow({ where: { importId: dm.id } });
    expect(inv.companyKey).toBe("dmpl");
    expect((await prisma.salesPayment.findFirstOrThrow({ where: { importId: dm.id } })).companyKey).toBe("dmpl");
    expect(await seq("invoice@dmpl:2024-25")).toBe(6);
  });

  it("T-34 BIGINT landed totals and the report CSV", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => oneRow({ no: `INV/22-23/${String(i + 1).padStart(4, "0")}`, date: "01/10/2022", gstin: "29AAGCS5678L1ZH", pos: "29", taxable: "2,00,00,000.00", total: i === 0 ? "1,99,99,999.53" : "2,00,00,000.00" }));
    const done = await applied(csvOf(rows));
    expect(done.totalPaise).toBe(24_000_000_000 - 47);
    expect(done.landed.totalPaise).toBe(24_000_000_000 - 47);
    const row = await prisma.salesImport.findUniqueOrThrow({ where: { id: done.id }, select: { totalPaise: true } });
    expect(row.totalPaise).toBe(BigInt(24_000_000_000 - 47));
    const csv = await request(app).get(`/v1/sales/imports/${done.id}/report.csv`).set(auth(salesToken)).buffer(true).parse(binary);
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["access-control-expose-headers"]).toContain("Content-Disposition");
    expect(csv.headers["content-disposition"]).toMatch(/swipe-import-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.csv/);
    const text = (csv.body as Buffer).toString("utf8");
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain(",-0.47,");
    expect(text).toContain("Imports totals");
    expect(text).toContain("239999999.53");
    expect(text.split("\r\n")[0]).toContain("Invoice number,Rows,Date,FY,Customer");
  });

  it("T-35 imported invoices stay out of the client portal", async () => {
    const done = await applied(worked());
    const inv = await prisma.salesInvoice.findFirstOrThrow({ where: { importId: done.id, clientId: C.filmy } });
    const list = await request(app).get("/v1/client/invoices").set(auth(clientToken));
    expect(list.status).toBe(200);
    expect(list.body.data.some((i: { id: string }) => i.id === inv.id)).toBe(false);
    expect((await request(app).get(`/v1/client/invoices/${inv.id}/pdf`).set(auth(clientToken))).status).toBe(404);
  });

  it("T-36 dashboard: this year's imported invoices count; the feed shows the import, not its thousand rows", async () => {
    const done = await applied(worked());
    const dash = (await request(app).get("/v1/sales/dashboard?company=dspl").set(auth(salesToken))).body.data;
    expect(dash.invoicedFyPaise).toBe(7_356_800 + 4_720_000);
    const recent = dash.recent as Array<{ entityType: string; action: string; label: string | null; entityId: string }>;
    expect(recent.some((e) => e.entityType === "import" && e.action === "applied" && e.entityId === done.id && e.label === "Swipe import · swipe.csv")).toBe(true);
    expect(recent.some((e) => e.action === "imported" || e.action === "payment_imported" || e.action === "client_imported")).toBe(false);
  });

  it("T-37 kill switch, discard and the import's own history", async () => {
    const done = await applied(worked());
    const draft = await uploaded(csvOf([oneRow({ no: "INV/22-23/0001", date: "01/10/2022", taxable: "100", cgst: "9", sgst: "9", total: "118" })]));
    vi.stubEnv("SALES_IMPORT_ENABLED", "0");
    expect((await upload(salesToken, worked())).status).toBe(503);
    expect((await request(app).put(`/v1/sales/imports/${draft.id}/mapping`).set(auth(salesToken)).send({ mapping: draft.mapping, options: draft.options })).body.error.code).toBe("IMPORT_OFF");
    expect((await apply(draft.id, { planHash: draft.planHash })).status).toBe(503);
    expect((await request(app).get(`/v1/sales/imports/${draft.id}`).set(auth(salesToken))).status).toBe(200);
    expect((await request(app).post(`/v1/sales/imports/${done.id}/undo`).set(auth(adminToken)).send({ reason: "kill switch test" })).status).toBe(200);
    vi.unstubAllEnvs();
    expect((await request(app).delete(`/v1/sales/imports/${done.id}`).set(auth(salesToken))).body.error.code).toBe("IMPORT_NOT_DRAFT");
    expect((await request(app).delete(`/v1/sales/imports/${draft.id}`).set(auth(salesToken))).body.data).toEqual({ deleted: true });
    expect(await prisma.salesImport.count({ where: { id: draft.id } })).toBe(0);
    expect(await prisma.salesImportInvoice.count({ where: { importId: draft.id } })).toBe(0);
    const ev = await request(app).get(`/v1/sales/events?entityType=import&entityId=${done.id}`).set(auth(salesToken));
    const actions = ev.body.data.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["uploaded", "apply_started", "applied", "undone"]));
  });

  it("T-38 reconciliation equals the check by financial year, and notices a tampered total", async () => {
    const done = await applied(worked());
    expect(done.summary.reconcile.ok).toBe(true);
    const byFy = done.summary.reconcile.byFy.map((f: { fy: string; invoices: number; totalPaise: number; planTotalPaise: number }) => [f.fy, f.invoices, f.totalPaise, f.planTotalPaise]);
    expect(byFy).toEqual([["2024-25", 1, 11_800_000, 11_800_000], [FY.label, 2, 12_076_800, 12_076_800]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    expect(done.summary.byFy.map((f: { fy: string; totalPaise: number }) => [f.fy, f.totalPaise])).toEqual(byFy.map((b: unknown[]) => [b[0], b[2]]));
    await prisma.salesInvoice.updateMany({ where: { importId: done.id, number: "INV/24-25/0102" }, data: { totalPaise: 11_800_001 } });
    const rec = await rerunReconcile(done.id);
    expect(rec.ok).toBe(false);
    expect((await getImport(done.id)).summary.notices.map((n: { code: string }) => n.code)).toContain("RECONCILE_MISMATCH");
  });

  it("an XLSX export with a real date cell imports on the right day", async () => {
    const XLSX = await import("xlsx");
    const ws = XLSX.utils.aoa_to_sheet([
      ["Invoice Number", "Invoice Date", "Customer Name", "Customer GSTIN", "Taxable Value", "CGST", "SGST", "Total"],
      ["INV/24-25/0200", 0, "Filmy Brands", "27AAPFU0939F1ZV", 1000, 90, 90, 1180],
    ]);
    ws.B2 = { t: "n", v: 45455, z: "dd/mm/yyyy" };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sales");
    const r = await upload(salesToken, Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })), "swipe.xlsx");
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.file.kind).toBe("xlsx");
    const rows = (await request(app).get(`/v1/sales/imports/${r.body.data.id}/invoices`).set(auth(salesToken))).body.data.rows;
    expect(rows[0]).toMatchObject({ issueDate: "2024-06-12", outcome: "warning" }); // unpaid since 2024 → OLD_RECEIVABLE
    expect(rows[0].issues.map((i: { code: string }) => i.code)).toContain("OLD_RECEIVABLE");
  });
});
