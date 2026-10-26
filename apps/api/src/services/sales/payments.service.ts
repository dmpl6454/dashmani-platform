import { prisma } from "@dashmani/db";
import { todayIST, type PaymentAllocateInput, type PaymentCreateInput, type CreditNoteCreateInput, computeTotals, type TaxMode } from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { dateToDay, dayToDate, lockInvoices, logSalesEvent, nextDocumentNumber, type Tx } from "./common";
import { getSellerOrDefaults } from "./settings.service";
import { recomputeSettlement } from "./invoices.service";

// Money in: a payment (or TDS the client withheld) allocated across one or more issued
// invoices — when it is recorded, or later from its unallocated remainder (an advance) — and
// credit notes that reduce an issued tax invoice. Every change ends in recomputeSettlement for
// each invoice touched — the one place balances are written.

const paymentInclude = {
  client: { select: { id: true, companyName: true } },
  allocations: { include: { invoice: { select: { id: true, number: true, totalPaise: true } } } },
} as const;

const rs = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
  return rows.map((p) => ({ ...p, paidOn: dateToDay(p.paidOn) }));
}

export async function getPayment(id: string) {
  const p = await prisma.salesPayment.findUnique({ where: { id }, include: paymentInclude });
  if (!p) throw new AppError(404, "NOT_FOUND", "Payment not found");
  return { ...p, paidOn: dateToDay(p.paidOn) };
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
 * Apply what is still unallocated on a recorded receipt (an advance, or the rest of a part-used
 * payment) to the client's invoices. Allocating to an invoice the receipt already covers tops
 * that allocation up.
 */
export async function allocatePayment(paymentId: string, input: PaymentAllocateInput, actorId: string) {
  await prisma.$transaction(async (tx) => {
    // The receipt row first (two people applying the same advance queue here), then the invoices.
    await tx.$queryRaw`SELECT id FROM sales_payments WHERE id = ${paymentId} FOR UPDATE`;
    const p = await tx.salesPayment.findUnique({ where: { id: paymentId }, include: { allocations: true } });
    if (!p) throw new AppError(404, "NOT_FOUND", "Payment not found");
    const usedAmount = p.allocations.reduce((s, a) => s + a.amountPaise, 0);
    const usedTds = p.allocations.reduce((s, a) => s + a.tdsPaise, 0);
    const addAmount = input.allocations.reduce((s, a) => s + a.amountPaise, 0);
    const addTds = input.allocations.reduce((s, a) => s + a.tdsPaise, 0);
    if (usedAmount + addAmount > p.amountPaise) throw new AppError(409, "OVER_ALLOCATED", `Only ${rs(p.amountPaise - usedAmount)} of ${p.number} is unallocated`);
    if (usedTds + addTds > p.tdsPaise) throw new AppError(409, "OVER_ALLOCATED", `Only ${rs(p.tdsPaise - usedTds)} of TDS on ${p.number} is unallocated`);
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

export async function createCreditNote(input: CreditNoteCreateInput, actorId: string) {
  const seller = await getSellerOrDefaults();
  const issueDate = input.issueDate ?? todayIST();
  const created = await prisma.$transaction(async (tx) => {
    // Locked before the room check, so two credit notes at once cannot both fit in the same room.
    await lockInvoices(tx, [input.invoiceId]);
    const inv = await tx.salesInvoice.findUnique({
      where: { id: input.invoiceId },
      select: { id: true, number: true, clientId: true, status: true, kind: true, taxMode: true, gstRateBp: true, taxablePaise: true, cgstPaise: true, sgstPaise: true, igstPaise: true, totalPaise: true },
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
    // the earlier notes already took. Rounding each note on its own drifted — two halves of a
    // ₹119 invoice came to ₹118, three thirds to ₹120. The note that credits the last of the
    // taxable value takes exactly the invoice's own tax and total, so a full credit always lands
    // on zero. Totals stay whole rupees when the invoice's total is whole rupees.
    const after = before.taxable + input.taxablePaise;
    const target = after === inv.taxablePaise
      ? { cgst: inv.cgstPaise, sgst: inv.sgstPaise, igst: inv.igstPaise, total: inv.totalPaise }
      : (() => {
          const t = computeTotals({ lines: [{ quantity: 1, unitPricePaise: after }], taxMode: inv.taxMode as TaxMode, gstRateBp: inv.gstRateBp, roundToRupee: inv.totalPaise % 100 === 0 });
          return { cgst: t.cgstPaise, sgst: t.sgstPaise, igst: t.igstPaise, total: t.totalPaise };
        })();
    const note = {
      cgst: target.cgst - before.cgst, sgst: target.sgst - before.sgst, igst: target.igst - before.igst, total: target.total - before.total,
    };
    if (note.total <= 0 || note.cgst < 0 || note.sgst < 0 || note.igst < 0) {
      throw new AppError(422, "CREDIT_TOO_SMALL", "That amount rounds to nothing on this invoice — credit a larger amount");
    }
    const number = await nextDocumentNumber(tx, "credit_note", seller.creditNotePrefix, issueDate);
    const cn = await tx.salesCreditNote.create({
      data: {
        number,
        invoiceId: inv.id,
        clientId: inv.clientId,
        issueDate: dayToDate(issueDate),
        reason: input.reason,
        taxMode: inv.taxMode,
        gstRateBp: inv.gstRateBp,
        taxablePaise: input.taxablePaise,
        cgstPaise: note.cgst,
        sgstPaise: note.sgst,
        igstPaise: note.igst,
        totalPaise: note.total,
        createdById: actorId,
      },
      select: { id: true },
    });
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
