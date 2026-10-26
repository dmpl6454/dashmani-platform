import { prisma } from "@dashmani/db";
import { registrationByGstin, todayIST, type PaymentAllocateInput, type PaymentCreateInput, type CreditNoteCreateInput, type RefundCreateInput, computeTotals, type TaxMode } from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { dateToDay, dayToDate, lockInvoices, logSalesEvent, nextDocumentNumber, type Tx } from "./common";
import { getSellerOrDefaults } from "./settings.service";
import { recomputeSettlement, releaseExcess } from "./invoices.service";

// Money in and back out. A payment (receipt) is allocated across the client's issued invoices —
// when it is recorded, or later from its unallocated remainder (an advance). A credit note
// reduces an issued tax invoice; if that invoice was already settled, the excess goes back to
// the receipts it came from (releaseExcess) and shows as the client's unapplied credit, which can
// be applied to another invoice or refunded (a refund, RF/26-27/0001). A receipt recorded by
// mistake (bounced cheque, typo) is VOIDED: it keeps its number, its allocations stop counting.
// Every change ends in recomputeSettlement for each invoice touched — the one writer of balances.

const paymentInclude = {
  client: { select: { id: true, companyName: true } },
  allocations: { include: { invoice: { select: { id: true, number: true, totalPaise: true } } } },
  refunds: { orderBy: { createdAt: "asc" as const } },
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

function present<T extends PaymentRow>(p: T) {
  return {
    ...p,
    paidOn: dateToDay(p.paidOn),
    refunds: p.refunds.map((r) => ({ ...r, refundedOn: dateToDay(r.refundedOn) })),
    ...receiptBalance(p),
  };
}

export async function listPayments(filter: { clientId?: string; q?: string; from?: string; to?: string }) {
  const term = filter.q?.trim();
  const rows = await prisma.salesPayment.findMany({
    where: {
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
async function checkAllocations(tx: Tx, clientId: string, allocations: Array<{ invoiceId: string; amountPaise: number; tdsPaise: number }>) {
  const ids = allocations.map((a) => a.invoiceId);
  if (!ids.length) return;
  // Balances are read AFTER the lock: a second payment for the same invoice waits here and then
  // sees the first one's allocation, so the two can never over-settle it.
  await lockInvoices(tx, ids);
  const invoices = await tx.salesInvoice.findMany({
    where: { id: { in: ids } },
    select: { id: true, number: true, clientId: true, status: true, totalPaise: true, paidPaise: true, tdsPaise: true, creditedPaise: true },
  });
  for (const a of allocations) {
    const inv = invoices.find((i) => i.id === a.invoiceId);
    if (!inv) throw new AppError(404, "NOT_FOUND", "An allocated invoice does not exist");
    if (inv.clientId !== clientId) throw new AppError(409, "WRONG_CLIENT", `${inv.number ?? "That invoice"} belongs to another client`);
    if (inv.status !== "issued" && inv.status !== "paid") throw new AppError(409, "NOT_ISSUED", `${inv.number ?? "That invoice"} is ${inv.status}; only an issued invoice can take a payment`);
    const balance = inv.totalPaise - inv.paidPaise - inv.tdsPaise - inv.creditedPaise;
    if (a.amountPaise + a.tdsPaise > balance) throw new AppError(409, "OVER_ALLOCATED", `${inv.number} has only ${rs(Math.max(0, balance))} outstanding`);
    if (a.amountPaise + a.tdsPaise === 0) throw new AppError(400, "EMPTY_ALLOCATION", "An allocation needs an amount or TDS");
  }
}

/** Lock a receipt row and read it with what hangs off it (allocations, refunds). */
async function lockPayment(tx: Tx, paymentId: string) {
  await tx.$queryRaw`SELECT id FROM sales_payments WHERE id = ${paymentId} FOR UPDATE`;
  const p = await tx.salesPayment.findUnique({ where: { id: paymentId }, include: { allocations: true, refunds: true } });
  if (!p) throw new AppError(404, "NOT_FOUND", "Payment not found");
  return p;
}

export async function createPayment(input: PaymentCreateInput, actorId: string) {
  const seller = await getSellerOrDefaults();
  const invoiceIds = input.allocations.map((a) => a.invoiceId);
  const created = await prisma.$transaction(async (tx) => {
    await checkAllocations(tx, input.clientId, input.allocations);
    const number = await nextDocumentNumber(tx, "receipt", seller.receiptPrefix, input.paidOn);
    const p = await tx.salesPayment.create({
      data: {
        number,
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
      },
      select: { id: true },
    });
    for (const id of invoiceIds) {
      await recomputeSettlement(tx, id);
      await logSalesEvent(tx, { entityType: "invoice", entityId: id, actorId, action: "payment_allocated", note: number });
    }
    await logSalesEvent(tx, { entityType: "payment", entityId: p.id, actorId, action: "recorded", note: `${input.mode} ${input.reference ?? ""}`.trim() });
    return p;
  });
  return getPayment(created.id);
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
    await checkAllocations(tx, p.clientId, input.allocations);
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
  return getPayment(paymentId);
}

/**
 * Void a receipt recorded by mistake (a bounced cheque, a wrong amount). It keeps its number and
 * its history; its allocations stop counting, so the invoices it paid are open again. A receipt
 * with refunds out of it cannot be voided until those refunds are cancelled.
 */
export async function voidPayment(paymentId: string, reason: string, actorId: string) {
  await prisma.$transaction(async (tx) => {
    const p = await lockPayment(tx, paymentId);
    if (p.status === "voided") return;
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
  });
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
    const number = await nextDocumentNumber(tx, "refund", "RF", input.refundedOn);
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
      invoice: { select: { id: true, number: true, issueDate: true, placeOfSupplyCode: true, sellerSnapshot: true, buyerSnapshot: true, items: { select: { sac: true }, take: 1, orderBy: { position: "asc" } } } },
      client: { select: { id: true, companyName: true } },
    },
  });
  if (!cn) throw new AppError(404, "NOT_FOUND", "Credit note not found");
  return { ...cn, issueDate: dateToDay(cn.issueDate), invoice: { ...cn.invoice, issueDate: dateToDay(cn.invoice.issueDate) } };
}

export type CreditNoteView = Awaited<ReturnType<typeof getCreditNote>>;

export async function createCreditNote(input: CreditNoteCreateInput, actorId: string) {
  const seller = await getSellerOrDefaults();
  const issueDate = input.issueDate ?? todayIST();
  const created = await prisma.$transaction(async (tx) => {
    // Locked before the room check, so two credit notes at once cannot both fit in the same room.
    await lockInvoices(tx, [input.invoiceId]);
    const inv = await tx.salesInvoice.findUnique({
      where: { id: input.invoiceId },
      select: { id: true, number: true, clientId: true, status: true, kind: true, taxMode: true, gstRateBp: true, taxablePaise: true, cgstPaise: true, sgstPaise: true, igstPaise: true, totalPaise: true, sellerSnapshot: true },
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
    // A credit note is numbered in the series of the GSTIN that issued the invoice.
    const reg = registrationByGstin(seller, (inv.sellerSnapshot as { gstin?: string | null } | null)?.gstin);
    const number = await nextDocumentNumber(tx, "credit_note", reg.creditNotePrefix, issueDate, reg.scope);
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
    return cn;
  });
  const cn = await prisma.salesCreditNote.findUniqueOrThrow({
    where: { id: created.id },
    include: { invoice: { select: { id: true, number: true } }, client: { select: { id: true, companyName: true } } },
  });
  return { ...cn, issueDate: dateToDay(cn.issueDate) };
}

export async function cancelCreditNote(id: string, actorId: string) {
  const found = await prisma.salesCreditNote.findUnique({ where: { id }, select: { invoiceId: true } });
  if (!found) throw new AppError(404, "NOT_FOUND", "Credit note not found");
  await prisma.$transaction(async (tx) => {
    await lockInvoices(tx, [found.invoiceId]);
    const cn = await tx.salesCreditNote.findUnique({ where: { id }, select: { status: true, invoiceId: true, number: true } });
    if (!cn || cn.status === "cancelled") return;
    await tx.salesCreditNote.update({ where: { id }, data: { status: "cancelled", cancelledAt: new Date() } });
    await recomputeSettlement(tx, cn.invoiceId);
    await logSalesEvent(tx, { entityType: "credit_note", entityId: id, actorId, action: "cancelled", fromStatus: "issued", toStatus: "cancelled", note: cn.number });
  });
}
