import { prisma, type Prisma } from "@dashmani/db";
import { companyScope, MAX_PAISE, registrationByGstin, SALES_COMPANIES, todayIST, type CompanyKey, type PaymentAllocateInput, type PaymentCreateInput, type CreditNoteCreateInput, type RefundCreateInput, computeTotals, type TaxMode } from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { dateToDay, dayToDate, inBackground, lockInvoices, logSalesEvent, nextDocumentNumber, type Tx } from "./common";
import { queueInvoiceEmails } from "./invoice-email.service";
import { getSellerOrDefaults } from "./settings.service";
import { recomputeSettlement, releaseExcess } from "./invoices.service";
import { assertEInvoiceData, cancelEInvoiceFor, needsEInvoice, queueCreditNoteEInvoice, registerEInvoice } from "./einvoice.service";

// Money in and back out. A payment (receipt) is allocated across the client's issued invoices —
// when it is recorded, or later from its unallocated remainder (an advance). A credit note
// reduces an issued tax invoice; if that invoice was already settled, the excess goes back to
// the receipts it came from (releaseExcess) and shows as the client's unapplied credit, which can
// be applied to another invoice or refunded (a refund, RF/26-27/0001). A receipt recorded by
// mistake (bounced cheque, typo) is VOIDED: it keeps its number, its allocations stop counting.
// Every change ends in recomputeSettlement for each invoice touched — the one writer of balances.

const paymentInclude = {
  client: { select: { id: true, companyName: true } },
  allocations: { include: { invoice: { select: { id: true, number: true, totalPaise: true, companyKey: true } } } },
  refunds: { orderBy: { createdAt: "asc" as const } },
  // Bank (PR 4): the statement credit this receipt is matched to. The account number is cut to its
  // last 4 digits in present() — a payment never carries the full number.
  bankLine: {
    select: {
      id: true, txnDate: true, rowNo: true,
      statement: { select: { fileName: true } },
      bankAccount: { select: { label: true, accountNumber: true } },
    },
  },
} as const;

const rs = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type PaymentRow = {
  amountPaise: number; tdsPaise: number; status: string; paidOn: Date;
  allocations: Array<{ amountPaise: number; tdsPaise: number }>;
  refunds: Array<{ amountPaise: number; status: string; refundedOn: Date }>;
};

/** What a receipt has left: cash not on an invoice and not refunded, and TDS not on an invoice. A voided receipt has nothing. */
export function receiptBalance(p: PaymentRow) {
  const allocatedPaise = p.allocations.reduce((s, a) => s + a.amountPaise, 0);
  const allocatedTdsPaise = p.allocations.reduce((s, a) => s + a.tdsPaise, 0);
  const refundedPaise = p.refunds.filter((r) => r.status === "issued").reduce((s, r) => s + r.amountPaise, 0);
  const live = p.status === "recorded";
  return {
    allocatedPaise,
    allocatedTdsPaise,
    refundedPaise,
    unallocatedPaise: live ? Math.max(0, p.amountPaise - allocatedPaise - refundedPaise) : 0,
    unallocatedTdsPaise: live ? Math.max(0, p.tdsPaise - allocatedTdsPaise) : 0,
  };
}

type BankLineRef = { id: string; txnDate: Date; rowNo: number; statement: { fileName: string }; bankAccount: { label: string; accountNumber: string } } | null;

function present<T extends PaymentRow & { bankLine?: BankLineRef }>(p: T) {
  const bl = p.bankLine ?? null;
  return {
    ...p,
    bankLine: bl
      ? { id: bl.id, txnDate: dateToDay(bl.txnDate), rowNo: bl.rowNo, statement: { fileName: bl.statement.fileName }, bankAccount: { label: bl.bankAccount.label, last4: bl.bankAccount.accountNumber.replace(/\D/g, "").slice(-4) } }
      : null,
    paidOn: dateToDay(p.paidOn),
    refunds: p.refunds.map((r) => ({ ...r, refundedOn: dateToDay(r.refundedOn) })),
    ...receiptBalance(p),
  };
}

export async function listPayments(filter: { clientId?: string; q?: string; from?: string; to?: string; companyKey?: CompanyKey }) {
  const term = filter.q?.trim();
  const rows = await prisma.salesPayment.findMany({
    where: {
      ...(filter.companyKey ? { companyKey: filter.companyKey } : {}),
      ...(filter.clientId ? { clientId: filter.clientId } : {}),
      ...(filter.from || filter.to ? { paidOn: { ...(filter.from ? { gte: dayToDate(filter.from) } : {}), ...(filter.to ? { lte: dayToDate(filter.to) } : {}) } } : {}),
      ...(term ? { OR: [{ number: { contains: term, mode: "insensitive" } }, { reference: { contains: term, mode: "insensitive" } }, { client: { companyName: { contains: term, mode: "insensitive" } } }] } : {}),
    },
    orderBy: [{ paidOn: "desc" }, { createdAt: "desc" }],
    take: 500,
    include: paymentInclude,
  });
  return rows.map(present);
}

export async function getPayment(id: string) {
  const p = await prisma.salesPayment.findUnique({ where: { id }, include: paymentInclude });
  if (!p) throw new AppError(404, "NOT_FOUND", "Payment not found");
  return present(p);
}

/**
 * The rules every allocation obeys, checked under the invoice row locks: the client's own
 * invoice, issued (not draft or cancelled), and no more than what is still outstanding on it.
 */
async function checkAllocations(tx: Tx, clientId: string, company: string, allocations: Array<{ invoiceId: string; amountPaise: number; tdsPaise: number }>) {
  const ids = allocations.map((a) => a.invoiceId);
  if (!ids.length) return;
  // Balances are read AFTER the lock: a second payment for the same invoice waits here and then
  // sees the first one's allocation, so the two can never over-settle it.
  await lockInvoices(tx, ids);
  const invoices = await tx.salesInvoice.findMany({
    where: { id: { in: ids } },
    select: { id: true, number: true, clientId: true, companyKey: true, status: true, totalPaise: true, paidPaise: true, tdsPaise: true, creditedPaise: true },
  });
  for (const a of allocations) {
    const inv = invoices.find((i) => i.id === a.invoiceId);
    if (!inv) throw new AppError(404, "NOT_FOUND", "An allocated invoice does not exist");
    if (inv.clientId !== clientId) throw new AppError(409, "WRONG_CLIENT", `${inv.number ?? "That invoice"} belongs to another client`);
    // Each company keeps its own books: money received by one can never settle the other's bill.
    if (inv.companyKey !== company) throw new AppError(409, "WRONG_COMPANY", `${inv.number ?? "That invoice"} is ${SALES_COMPANIES[inv.companyKey as CompanyKey]?.name ?? "the other company"}'s invoice — record the payment under that company`);
    if (inv.status !== "issued" && inv.status !== "paid") throw new AppError(409, "NOT_ISSUED", `${inv.number ?? "That invoice"} is ${inv.status}; only an issued invoice can take a payment`);
    const balance = inv.totalPaise - inv.paidPaise - inv.tdsPaise - inv.creditedPaise;
    if (a.amountPaise + a.tdsPaise > balance) throw new AppError(409, "OVER_ALLOCATED", `${inv.number} has only ${rs(Math.max(0, balance))} outstanding`);
    if (a.amountPaise + a.tdsPaise === 0) throw new AppError(400, "EMPTY_ALLOCATION", "An allocation needs an amount or TDS");
  }
}

/** Lock a receipt row and read it with what hangs off it (allocations, refunds). */
export async function lockPayment(tx: Tx, paymentId: string) {
  await tx.$queryRaw`SELECT id FROM sales_payments WHERE id = ${paymentId} FOR UPDATE`;
  const p = await tx.salesPayment.findUnique({ where: { id: paymentId }, include: { allocations: true, refunds: true } });
  if (!p) throw new AppError(404, "NOT_FOUND", "Payment not found");
  return p;
}

/** The columns recordReceiptTx always writes itself; a caller's `columns` can never override them. */
type ReceiptCoreKeys = "id" | "number" | "companyKey" | "clientId" | "amountPaise" | "tdsPaise" | "mode" | "reference"
  | "paidOn" | "bankName" | "notes" | "status" | "createdById" | "createdAt" | "updatedAt"
  | "recordedById" | "allocations" | "refunds" | "voidedAt" | "voidReason" | "voidedById";
/** Extra sales_payments columns a feature attaches to a receipt (import: importId; bank: bankLineId, tdsRateBp, tdsSection). Typed from Prisma, so a new column needs no edit here. */
export type ReceiptExtraColumns = Partial<Omit<Prisma.SalesPaymentUncheckedCreateInput, ReceiptCoreKeys>>;

/**
 * Record a receipt inside the caller's transaction — the one receipt core shared by the portal's
 * "Record payment" (createPayment), import's Swipe receipts and bank's matched credits
 * (spec-00 §2.6). In order: the allocation checks under the invoice locks, the number
 * (`opts.number`, else the next in the company's receipt series), the insert (with
 * `opts.columns`), then per invoice recomputeSettlement + an invoice event, then the payment
 * event. `imported: true` logs `payment_imported` / `imported` instead of `payment_allocated` /
 * `recorded`. It queues NO email — the caller decides (createPayment does, after commit).
 */
/**
 * The receipt-level rules paymentCreateSchema refines (each invoice once, allocations within the
 * cash and the TDS, something received, every figure a whole number of paise in range). The portal
 * route already passed them through Zod; import and bank build their input in code, so the core
 * checks them again — checkAllocations reads each invoice's balance once and would let two
 * allocations to one invoice over-settle it. Strings are not re-parsed (re-running safeString
 * could change a value the route already cleaned).
 */
function assertReceiptShape(input: PaymentCreateInput) {
  const bad = (msg: string): never => { throw new AppError(400, "INVALID_RECEIPT", msg); };
  const paiseOk = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= MAX_PAISE;
  if (!paiseOk(input.amountPaise) || !paiseOk(input.tdsPaise)) bad("The amount and TDS must be whole paise between 0 and the per-document limit");
  if (input.amountPaise + input.tdsPaise <= 0) bad("Enter an amount received or TDS withheld");
  const allocations = input.allocations ?? [];
  if (allocations.length > 50) bad("A receipt can settle at most 50 invoices");
  let amount = 0;
  let tds = 0;
  const seen = new Set<string>();
  for (const a of allocations) {
    if (!paiseOk(a.amountPaise) || !paiseOk(a.tdsPaise)) bad("Each allocation must be whole paise between 0 and the per-document limit");
    if (seen.has(a.invoiceId)) bad("List each invoice once in a payment");
    seen.add(a.invoiceId);
    amount += a.amountPaise;
    tds += a.tdsPaise;
  }
  if (amount > input.amountPaise) bad("Allocated more than was received");
  if (tds > input.tdsPaise) bad("Allocated more TDS than was withheld");
}

export async function recordReceiptTx(
  tx: Tx,
  input: PaymentCreateInput,
  actorId: string,
  opts: { receiptPrefix?: string; number?: string; imported?: boolean; columns?: ReceiptExtraColumns } = {},
): Promise<{ id: string; number: string; invoiceIds: string[] }> {
  assertReceiptShape(input);
  const invoiceIds = input.allocations.map((a) => a.invoiceId);
  await checkAllocations(tx, input.clientId, input.companyKey, input.allocations);
  let number: string;
  if (opts.number !== undefined) {
    number = opts.number;
  } else {
    if (opts.receiptPrefix === undefined) throw new Error("[sales] recordReceiptTx needs a receipt number or the receipt prefix");
    number = await nextDocumentNumber(tx, "receipt", opts.receiptPrefix, input.paidOn, companyScope(input.companyKey, null));
  }
  const p = await tx.salesPayment.create({
    data: {
      number,
      companyKey: input.companyKey,
      clientId: input.clientId,
      amountPaise: input.amountPaise,
      tdsPaise: input.tdsPaise,
      mode: input.mode,
      reference: input.reference ?? null,
      paidOn: dayToDate(input.paidOn),
      bankName: input.bankName ?? null,
      notes: input.notes ?? null,
      recordedById: actorId,
      allocations: { create: input.allocations.map((a) => ({ invoiceId: a.invoiceId, amountPaise: a.amountPaise, tdsPaise: a.tdsPaise })) },
      ...opts.columns,
    },
    select: { id: true },
  });
  for (const id of invoiceIds) {
    await recomputeSettlement(tx, id);
    await logSalesEvent(tx, { entityType: "invoice", entityId: id, actorId, action: opts.imported ? "payment_imported" : "payment_allocated", note: number });
  }
  await logSalesEvent(tx, { entityType: "payment", entityId: p.id, actorId, action: opts.imported ? "imported" : "recorded", note: `${input.mode} ${input.reference ?? ""}`.trim() });
  return { id: p.id, number, invoiceIds };
}

export async function createPayment(input: PaymentCreateInput, actorId: string) {
  const seller = await getSellerOrDefaults(input.companyKey);
  const { id, invoiceIds } = await prisma.$transaction((tx) =>
    recordReceiptTx(tx, input, actorId, {
      receiptPrefix: seller.receiptPrefix,
      columns: { tdsRateBp: input.tdsRateBp ?? null, tdsSection: input.tdsSection ?? null },
    }),
  );
  // After commit: the invoice PDF goes to the client and the company's billing addresses.
  queueInvoiceEmails(invoiceIds, id, actorId);
  return getPayment(id);
}

/**
 * Apply what is still unallocated on a recorded receipt (an advance, the rest of a part-used
 * payment, or credit a credit note released) to the client's invoices. Allocating to an invoice
 * the receipt already covers tops that allocation up.
 */
export async function allocatePayment(paymentId: string, input: PaymentAllocateInput, actorId: string) {
  await prisma.$transaction(async (tx) => {
    // The receipt row first (two people applying the same advance queue here), then the invoices.
    const p = await lockPayment(tx, paymentId);
    if (p.status !== "recorded") throw new AppError(409, "PAYMENT_VOIDED", `${p.number} was voided — it has nothing to apply`);
    const left = receiptBalance(p);
    const addAmount = input.allocations.reduce((s, a) => s + a.amountPaise, 0);
    const addTds = input.allocations.reduce((s, a) => s + a.tdsPaise, 0);
    if (addAmount > left.unallocatedPaise) throw new AppError(409, "OVER_ALLOCATED", `Only ${rs(left.unallocatedPaise)} of ${p.number} is unallocated`);
    if (addTds > left.unallocatedTdsPaise) throw new AppError(409, "OVER_ALLOCATED", `Only ${rs(left.unallocatedTdsPaise)} of TDS on ${p.number} is unallocated`);
    await checkAllocations(tx, p.clientId, p.companyKey, input.allocations);
    for (const a of input.allocations) {
      await tx.salesPaymentAllocation.upsert({
        where: { paymentId_invoiceId: { paymentId, invoiceId: a.invoiceId } },
        create: { paymentId, invoiceId: a.invoiceId, amountPaise: a.amountPaise, tdsPaise: a.tdsPaise },
        update: { amountPaise: { increment: a.amountPaise }, tdsPaise: { increment: a.tdsPaise } },
      });
      await recomputeSettlement(tx, a.invoiceId);
      await logSalesEvent(tx, { entityType: "invoice", entityId: a.invoiceId, actorId, action: "payment_allocated", note: p.number });
    }
    await logSalesEvent(tx, { entityType: "payment", entityId: p.id, actorId, action: "allocated", note: `${rs(addAmount + addTds)} applied` });
  });
  queueInvoiceEmails(input.allocations.map((a) => a.invoiceId), paymentId, actorId);
  return getPayment(paymentId);
}

/**
 * Void a receipt recorded by mistake (a bounced cheque, a wrong amount). It keeps its number and
 * its history; its allocations stop counting, so the invoices it paid are open again. A receipt
 * with refunds out of it cannot be voided until those refunds are cancelled.
 */
export async function voidPaymentInTx(tx: Tx, paymentId: string, reason: string, actorId: string): Promise<{ bankLineId: string | null }> {
  const p = await lockPayment(tx, paymentId);
  if (p.status === "voided") return { bankLineId: p.bankLineId ?? null };
  if (p.refunds.some((r) => r.status === "issued")) {
    throw new AppError(409, "PAYMENT_HAS_REFUNDS", `${p.number} has refunds against it — cancel them before voiding the receipt`);
  }
  const invoiceIds = [...new Set(p.allocations.map((a) => a.invoiceId))];
  await lockInvoices(tx, invoiceIds);
  await tx.salesPayment.update({ where: { id: paymentId }, data: { status: "voided", voidedAt: new Date(), voidReason: reason, voidedById: actorId } });
  for (const id of invoiceIds) {
    await recomputeSettlement(tx, id);
    await logSalesEvent(tx, { entityType: "invoice", entityId: id, actorId, action: "payment_voided", note: `${p.number} — ${reason}` });
  }
  await logSalesEvent(tx, { entityType: "payment", entityId: p.id, actorId, action: "voided", fromStatus: "recorded", toStatus: "voided", note: reason });
  return { bankLineId: p.bankLineId ?? null };
}

export async function voidPayment(paymentId: string, reason: string, actorId: string) {
  // The receipt → invoices transaction is unchanged; a bank line the receipt was matched to (it
  // keeps bankLineId) is refreshed AFTER commit — confirm/link recompute under the line lock, so
  // the brief stale cache can never cause an over-match (spec-bank D10).
  const r = await prisma.$transaction((tx) => voidPaymentInTx(tx, paymentId, reason, actorId));
  if (r.bankLineId) {
    const lineId = r.bankLineId;
    inBackground("bank line refresh", async () => {
      const { refreshBankLineAfterVoid } = await import("./bank.service"); // dynamic: bank.service imports this file
      await refreshBankLineAfterVoid(lineId, paymentId, actorId);
    });
  }
  return getPayment(paymentId);
}

// ── Refunds ─────────────────────────────────────────────────────────────────────

/** Pay money back to the client out of a receipt's unallocated cash (TDS is never refunded in cash). */
export async function createRefund(paymentId: string, input: RefundCreateInput, actorId: string) {
  await prisma.$transaction(async (tx) => {
    const p = await lockPayment(tx, paymentId);
    if (p.status !== "recorded") throw new AppError(409, "PAYMENT_VOIDED", `${p.number} was voided — there is nothing to refund`);
    const left = receiptBalance(p);
    if (input.amountPaise > left.unallocatedPaise) {
      throw new AppError(409, "OVER_REFUNDED", `Only ${rs(left.unallocatedPaise)} of ${p.number} is free to refund — money on an invoice comes back only through a credit note`);
    }
    if (input.refundedOn < dateToDay(p.paidOn)!) throw new AppError(422, "REFUND_BEFORE_PAYMENT", `A refund cannot be dated before the receipt (${dateToDay(p.paidOn)})`);
    const company = p.companyKey as CompanyKey;
    const number = await nextDocumentNumber(tx, "refund", SALES_COMPANIES[company].refundPrefix, input.refundedOn, companyScope(company, null));
    const r = await tx.salesRefund.create({
      data: {
        number,
        paymentId,
        clientId: p.clientId,
        amountPaise: input.amountPaise,
        mode: input.mode,
        reference: input.reference ?? null,
        refundedOn: dayToDate(input.refundedOn),
        notes: input.notes ?? null,
        createdById: actorId,
      },
      select: { id: true },
    });
    await logSalesEvent(tx, { entityType: "payment", entityId: p.id, actorId, action: "refunded", note: `${number} · ${rs(input.amountPaise)} ${input.mode}${input.reference ? ` ${input.reference}` : ""}` });
    return r;
  });
  return getPayment(paymentId);
}

export async function cancelRefund(refundId: string, actorId: string) {
  const found = await prisma.salesRefund.findUnique({ where: { id: refundId }, select: { paymentId: true } });
  if (!found) throw new AppError(404, "NOT_FOUND", "Refund not found");
  await prisma.$transaction(async (tx) => {
    await lockPayment(tx, found.paymentId);
    const r = await tx.salesRefund.findUnique({ where: { id: refundId }, select: { status: true, number: true } });
    if (!r || r.status === "cancelled") return;
    await tx.salesRefund.update({ where: { id: refundId }, data: { status: "cancelled", cancelledAt: new Date() } });
    await logSalesEvent(tx, { entityType: "payment", entityId: found.paymentId, actorId, action: "refund_cancelled", note: r.number });
  });
  return getPayment(found.paymentId);
}

// ── Credit notes ────────────────────────────────────────────────────────────────

export async function listCreditNotes(filter: { invoiceId?: string; clientId?: string }) {
  const rows = await prisma.salesCreditNote.findMany({
    where: { ...(filter.invoiceId ? { invoiceId: filter.invoiceId } : {}), ...(filter.clientId ? { clientId: filter.clientId } : {}) },
    orderBy: { createdAt: "desc" },
    take: 500,
    include: { invoice: { select: { id: true, number: true } }, client: { select: { id: true, companyName: true } } },
  });
  return rows.map((c) => ({ ...c, issueDate: dateToDay(c.issueDate) }));
}

export async function getCreditNote(id: string) {
  const cn = await prisma.salesCreditNote.findUnique({
    where: { id },
    include: {
      invoice: { select: { id: true, companyKey: true, number: true, issueDate: true, placeOfSupplyCode: true, sellerSnapshot: true, buyerSnapshot: true, items: { select: { sac: true }, take: 1, orderBy: { position: "asc" } } } },
      client: { select: { id: true, companyName: true } },
      einvoice: { select: { status: true, irn: true, ackNo: true, ackDate: true, signedQrCode: true } },
    },
  });
  if (!cn) throw new AppError(404, "NOT_FOUND", "Credit note not found");
  return { ...cn, issueDate: dateToDay(cn.issueDate), invoice: { ...cn.invoice, issueDate: dateToDay(cn.invoice.issueDate) } };
}

export type CreditNoteView = Awaited<ReturnType<typeof getCreditNote>>;

export async function createCreditNote(input: CreditNoteCreateInput, actorId: string) {
  // A credit note belongs to the company of the invoice it reduces (fixed since creation).
  const owner = await prisma.salesInvoice.findUnique({ where: { id: input.invoiceId }, select: { companyKey: true } });
  if (!owner) throw new AppError(404, "NOT_FOUND", "Invoice not found");
  const company = owner.companyKey as CompanyKey;
  const seller = await getSellerOrDefaults(company);
  const issueDate = input.issueDate ?? todayIST();
  const created = await prisma.$transaction(async (tx) => {
    // Locked before the room check, so two credit notes at once cannot both fit in the same room.
    await lockInvoices(tx, [input.invoiceId]);
    const inv = await tx.salesInvoice.findUnique({
      where: { id: input.invoiceId },
      select: { id: true, number: true, clientId: true, status: true, kind: true, taxMode: true, gstRateBp: true, taxablePaise: true, cgstPaise: true, sgstPaise: true, igstPaise: true, totalPaise: true, sellerSnapshot: true, buyerSnapshot: true },
    });
    if (!inv) throw new AppError(404, "NOT_FOUND", "Invoice not found");
    if (inv.status !== "issued" && inv.status !== "paid") throw new AppError(409, "NOT_ISSUED", "Only an issued invoice can take a credit note");
    if (inv.kind !== "tax_invoice") throw new AppError(409, "NOT_TAX_INVOICE", "A credit note reduces a tax invoice; a proforma is simply cancelled");
    const prior = await tx.salesCreditNote.aggregate({
      where: { invoiceId: inv.id, status: "issued" },
      _sum: { taxablePaise: true, cgstPaise: true, sgstPaise: true, igstPaise: true, totalPaise: true },
    });
    const before = {
      taxable: prior._sum.taxablePaise ?? 0, cgst: prior._sum.cgstPaise ?? 0, sgst: prior._sum.sgstPaise ?? 0,
      igst: prior._sum.igstPaise ?? 0, total: prior._sum.totalPaise ?? 0,
    };
    const room = inv.taxablePaise - before.taxable;
    if (input.taxablePaise > room) throw new AppError(409, "OVER_CREDITED", `Only ${rs(room)} of ${inv.number}'s taxable value can still be credited`);
    // Cumulative, never per note: each note is "credited so far, including this one" minus what
    // the earlier notes already took. The note that credits the last of the taxable value takes
    // exactly the invoice's own tax and total, so a full credit always lands on zero. Totals stay
    // whole rupees when the invoice's total is whole rupees.
    const after = before.taxable + input.taxablePaise;
    const target = after === inv.taxablePaise
      ? { cgst: inv.cgstPaise, sgst: inv.sgstPaise, igst: inv.igstPaise, total: inv.totalPaise }
      : (() => {
          const t = computeTotals({ lines: [{ quantity: 1, unitPricePaise: after }], taxMode: inv.taxMode as TaxMode, gstRateBp: inv.gstRateBp, roundToRupee: inv.totalPaise % 100 === 0 });
          return { cgst: t.cgstPaise, sgst: t.sgstPaise, igst: t.igstPaise, total: t.totalPaise };
        })();
    const note = { cgst: target.cgst - before.cgst, sgst: target.sgst - before.sgst, igst: target.igst - before.igst, total: target.total - before.total };
    if (note.total <= 0 || note.cgst < 0 || note.sgst < 0 || note.igst < 0) {
      throw new AppError(422, "CREDIT_TOO_SMALL", "That amount rounds to nothing on this invoice — credit a larger amount");
    }
    // A credit note to a registered buyer is itself an e-invoice document: check before numbering.
    const buyerSnap = (inv.buyerSnapshot ?? {}) as { gstin?: string | null; country?: string | null };
    const wantsIrn = needsEInvoice(seller, buyerSnap, issueDate);
    if (wantsIrn) assertEInvoiceData((inv.sellerSnapshot ?? {}) as object, buyerSnap);
    // A credit note is numbered in the series of the GSTIN that issued the invoice.
    const reg = registrationByGstin(seller, (inv.sellerSnapshot as { gstin?: string | null } | null)?.gstin);
    const number = await nextDocumentNumber(tx, "credit_note", reg.creditNotePrefix, issueDate, companyScope(company, reg.scope));
    const cn = await tx.salesCreditNote.create({
      data: {
        number, invoiceId: inv.id, clientId: inv.clientId, issueDate: dayToDate(issueDate), reason: input.reason,
        taxMode: inv.taxMode, gstRateBp: inv.gstRateBp, taxablePaise: input.taxablePaise,
        cgstPaise: note.cgst, sgstPaise: note.sgst, igstPaise: note.igst, totalPaise: note.total, createdById: actorId,
      },
      select: { id: true },
    });
    // Credited after it was (partly) paid: the money now beyond the total goes back to its receipts.
    await releaseExcess(tx, inv.id, actorId);
    await recomputeSettlement(tx, inv.id);
    await logSalesEvent(tx, { entityType: "credit_note", entityId: cn.id, actorId, action: "issued", toStatus: "issued", note: `${number} against ${inv.number}` });
    await logSalesEvent(tx, { entityType: "invoice", entityId: inv.id, actorId, action: "credit_note_issued", note: number });
    return { ...cn, einvoiceId: wantsIrn ? await queueCreditNoteEInvoice(tx, cn.id) : null };
  });
  if (created.einvoiceId) await registerEInvoice(created.einvoiceId, actorId);
  const cn = await prisma.salesCreditNote.findUniqueOrThrow({
    where: { id: created.id },
    include: { invoice: { select: { id: true, number: true } }, client: { select: { id: true, companyName: true } } },
  });
  return { ...cn, issueDate: dateToDay(cn.issueDate) };
}

export async function cancelCreditNote(id: string, actorId: string) {
  const found = await prisma.salesCreditNote.findUnique({ where: { id }, select: { invoiceId: true, status: true } });
  if (!found) throw new AppError(404, "NOT_FOUND", "Credit note not found");
  if (found.status !== "cancelled") await cancelEInvoiceFor({ creditNoteId: id }, "Credit note cancelled", actorId);
  await prisma.$transaction(async (tx) => {
    await lockInvoices(tx, [found.invoiceId]);
    const cn = await tx.salesCreditNote.findUnique({ where: { id }, select: { status: true, invoiceId: true, number: true } });
    if (!cn || cn.status === "cancelled") return;
    await tx.salesCreditNote.update({ where: { id }, data: { status: "cancelled", cancelledAt: new Date() } });
    await recomputeSettlement(tx, cn.invoiceId);
    await logSalesEvent(tx, { entityType: "credit_note", entityId: id, actorId, action: "cancelled", fromStatus: "issued", toStatus: "cancelled", note: cn.number });
  });
}
