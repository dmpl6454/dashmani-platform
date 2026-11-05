/**
 * Bank line races with a REAL connection pool (spec-bank §8.3 #5, #10, #21). The main suite runs
 * on connection_limit=1, which serialises every transaction, so these pass there with or without
 * the line lock. Here the pool is > 1 and the requests overlap for real.
 *
 *   cd apps/api && DATABASE_URL="postgresql://…/dashmani_bank?connection_limit=10" \
 *     npx vitest run -c vitest.concurrency.config.ts tests-concurrency/sales-bank
 *
 * Proven red→green by removing the FOR UPDATE in lockBankLine (bank.service.ts).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import { todayIST } from "@dashmani/shared";

vi.mock("../../src/services/email.service", async (orig) => {
  const real = await orig<typeof import("../../src/services/email.service")>();
  return { ...real, sendEmail: vi.fn(async () => ({ messageId: "test" })) };
});

import app from "../../src/app";
import { flushSalesBackground } from "../../src/services/sales/common";
import { createTestRole, createTestUser, generateToken } from "../../tests/helpers";

const SELLER = {
  legalName: "Digital Sukoon Private Limited", gstin: "27AAKCD3352K1ZF", pan: "AAKCD3352K", addressLine1: "702 Parinee I, Andheri West", city: "Mumbai",
  state: "Maharashtra", stateCode: "27", pincode: "400053", invoicePrefix: "INV", creditNotePrefix: "CN", receiptPrefix: "RCPT", defaultDueDays: 15, roundToRupee: true,
  email: "accounts@ds.test", autoEmailInvoices: false,
};
const ACC = "88452818788";
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const today = todayIST();
const d = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dmy = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
const rupees = (paise: number) => (paise / 100).toFixed(2);

function statement(rows: Array<{ date: string; narr: string; cr: number }>): Buffer {
  let bal = 100_000_000;
  const out: string[][] = [[`Account No : ${ACC}`], [], ["Transaction Date", "Particulars", "Cheque No", "Debit", "Credit", "Balance"]];
  for (const r of rows) { bal += r.cr; out.push([dmy(r.date), r.narr, "", "", rupees(r.cr), rupees(bal)]); }
  return Buffer.from(out.map((r) => r.join(",")).join("\r\n"));
}

describe("bank line races (real pool)", () => {
  let sales: string;
  let filmy: string;
  let accountId: string;
  const api = () => request(app);

  beforeEach(async () => {
    await prisma.systemSetting.deleteMany({ where: { key: { startsWith: "sales.seller" } } });
    await createTestRole("Sales", ["view", "manage"].map((action) => ({ resource: "sales", action, scope: "global" })));
    await createTestRole("Admin", ["view", "manage", "approve"].map((action) => ({ resource: "sales", action, scope: "global" })));
    const s = await createTestUser({ name: "Seller", roleNames: ["Sales"] });
    const a = await createTestUser({ name: "Boss", roleNames: ["Admin"] });
    sales = generateToken(s.id, s.email, ["Sales"]);
    const adminT = generateToken(a.id, a.email, ["Admin"]);
    expect((await api().put("/v1/sales/settings/seller").set(auth(adminT)).send(SELLER)).status).toBe(200);
    const f = await prisma.client.create({ data: { companyName: "Filmy Brands", contactName: "Riya", email: "riya@filmy.test", passwordHash: "x" } });
    await prisma.clientBillingProfile.create({ data: { clientId: f.id, legalName: "Filmy Brands Private Limited", stateCode: "27", state: "Maharashtra", city: "Mumbai" } });
    filmy = f.id;
    const acc = await api().post("/v1/sales/bank/accounts").set(auth(adminT)).send({ companyKey: "dspl", label: "IDFC First current", bank: "idfc", accountNumber: ACC });
    expect(acc.status).toBe(201);
    accountId = acc.body.data.id;
  });

  async function issued(unit: number) {
    const dr = await api().post("/v1/sales/invoices?company=dspl").set(auth(sales)).send({ clientId: filmy, companyKey: "dspl", items: [{ description: "Reel", quantity: 1, unitPricePaise: unit }] });
    const i = await api().post(`/v1/sales/invoices/${dr.body.data.id}/issue`).set(auth(sales)).send({ issueDate: d(-10) });
    expect(i.status, JSON.stringify(i.body)).toBe(200);
    return i.body.data as { id: string };
  }
  async function importRows(rows: Array<{ date: string; narr: string; cr: number }>, name: string) {
    const file = statement(rows);
    const p = await api().post("/v1/sales/bank/statements/preview?company=dspl").set(auth(sales)).field("bankAccountId", accountId).attach("file", file, name);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const r = await api().post("/v1/sales/bank/statements?company=dspl").set(auth(sales)).field("bankAccountId", accountId)
      .field("mapping", JSON.stringify(p.body.data.mapping)).field("expectedSha256", p.body.data.fileSha256).field("acceptWarnings", "true").attach("file", file, name);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await flushSalesBackground();
  }
  const lineId = async (narr: string) => (await prisma.salesBankLine.findFirstOrThrow({ where: { narration: narr } })).id;

  it("#5/#10 — four confirms of one credit at once: one receipt, the rest refused, the sequence moves once", async () => {
    for (let round = 0; round < 3; round++) {
      const narr = `NEFT CR RACE ROUND ${round}`;
      const amt = 50_000 + round * 1_000;
      await importRows([{ date: d(-1 - round), narr, cr: amt }], `race-${round}.csv`);
      const id = await lineId(narr);
      const before = await prisma.salesPayment.count();
      const res = await Promise.all(Array.from({ length: 4 }, () => api().post(`/v1/sales/bank/lines/${id}/confirm`).set(auth(sales)).send({ clientId: filmy, amountPaise: amt, ackExistingReceipt: true })));
      expect(res.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
      for (const r of res.filter((x) => x.status === 409)) expect(["BANK_LINE_SETTLED", "OVER_MATCHED"]).toContain(r.body.error.code);
      expect(await prisma.salesPayment.count()).toBe(before + 1);
      const line = await prisma.salesBankLine.findUniqueOrThrow({ where: { id } });
      expect([line.status, line.matchedPaise]).toEqual(["matched", BigInt(amt)]);
    }
    const seq = await prisma.salesSequence.findMany({ where: { key: { startsWith: "receipt" } } });
    expect(seq.map((s) => s.next)).toEqual([4]);
  });

  it("#21 — confirming one line while voiding another line's receipt on the same invoice: both land, the invoice adds up", async () => {
    const inv = await issued(20_000_000);
    await importRows([{ date: d(-1), narr: "NEFT CR LOCK ONE", cr: 5_000_000 }, { date: d(-1), narr: "NEFT CR LOCK TWO", cr: 5_000_000 }], "lock.csv");
    const l1 = await lineId("NEFT CR LOCK ONE");
    const l2 = await lineId("NEFT CR LOCK TWO");
    const r2 = (await api().post(`/v1/sales/bank/lines/${l2}/confirm`).set(auth(sales)).send({ clientId: filmy, amountPaise: 5_000_000, allocations: [{ invoiceId: inv.id, amountPaise: 5_000_000 }] })).body.data.payment;
    const res = await Promise.all([
      api().post(`/v1/sales/bank/lines/${l1}/confirm`).set(auth(sales)).send({ clientId: filmy, amountPaise: 5_000_000, allocations: [{ invoiceId: inv.id, amountPaise: 5_000_000 }], ackExistingReceipt: true }),
      api().post(`/v1/sales/bank/lines/${l2}/unlink`).set(auth(sales)).send({ paymentId: r2.id, action: "void", reason: "mistake" }),
    ]);
    expect(res.map((r) => r.status)).toEqual([201, 200]);
    await flushSalesBackground();
    const i = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(i.paidPaise).toBe(5_000_000);
    const [a, b] = await Promise.all([prisma.salesBankLine.findUniqueOrThrow({ where: { id: l1 } }), prisma.salesBankLine.findUniqueOrThrow({ where: { id: l2 } })]);
    expect([a.status, a.matchedPaise]).toEqual(["matched", 5_000_000n]);
    expect(b.matchedPaise).toBe(0n);
  });
});
