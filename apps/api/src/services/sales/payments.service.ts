import { prisma } from "@dashmani/db";
import { todayIST, type PaymentCreateInput, type CreditNoteCreateInput, computeTotals } from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { dateToDay, dayToDate, logSalesEvent, nextDocumentNumber } from "./common";
import { getSellerOrDefaults } from "./settings.service";
import { recomputeSettlement } from "./invoices.service";

// Money in: a payment (or TDS the client withheld) allocated across one or more issued
// invoices, and credit notes that reduce an issued invoice. Every change ends in
// recomputeSettlement for each invoice touched — the one place balances are written.

const paymentInclude = {
  client: { select: { id: true, companyName: true } },
  allocations: { include: { invoice: { select: { id: true, number: true, totalPaise: true } } } },
} as const;

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

export async function createPayment(input: PaymentCreateInput, actorId: string) {
  const seller = await getSellerOrDefaults();
  const invoiceIds = input.allocations.map((a) => a.invoiceId);
  const created = await prisma.$transaction(async (tx) => {
    if (invoiceIds.length) {
      const invoices = await tx.salesInvoice.findMany({
        where: { id: { in: invoiceIds } },
        select: { id: true, number: true, clientId: true, status: true, totalPaise: true, paidPaise: true, tdsPaise: true, creditedPaise: true },
      });
      for (const a of input.allocations) {
        const inv = invoices.find((i) => i.id === a.invoiceId);
        if (!inv) throw new AppError(404, "NOT_FOUND", "An allocated invoice does not exist");
        if (inv.clientId !== input.clientId) throw new AppError(409, "WRONG_CLIENT", `${inv.number ?? "That invoice"} belongs to another client`);
        if (inv.status !== "issued" && inv.status !== "paid") throw new AppError(409, "NOT_ISSUED", `${inv.number ?? "That invoice"} is ${inv.status}; only an issued invoice can take a payment`);
        const balance = inv.totalPaise - inv.paidPaise - inv.tdsPaise - inv.creditedPaise;
        if (a.amountPaise + a.tdsPaise > balance) throw new AppError(409, "OVER_ALLOCATED", `${inv.number} has only ${balance} paise outstanding`);
        if (a.amountPaise + a.tdsPaise === 0) throw new AppError(400, "EMPTY_ALLOCATION", "An allocation needs an amount or TDS");
      }
    }
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
    const inv = await tx.salesInvoice.findUnique({ where: { id: input.invoiceId }, select: { id: true, number: true, clientId: true, status: true, kind: true, taxMode: true, gstRateBp: true, taxablePaise: true } });
    if (!inv) throw new AppError(404, "NOT_FOUND", "Invoice not found");
    if (inv.status !== "issued" && inv.status !== "paid") throw new AppError(409, "NOT_ISSUED", "Only an issued invoice can take a credit note");
    const already = await tx.salesCreditNote.aggregate({ where: { invoiceId: inv.id, status: "issued" }, _sum: { taxablePaise: true } });
    const room = inv.taxablePaise - (already._sum.taxablePaise ?? 0);
    if (input.taxablePaise > room) throw new AppError(409, "OVER_CREDITED", `Only ${room} paise of ${inv.number} can still be credited`);
    const t = computeTotals({ lines: [{ quantity: 1, unitPricePaise: input.taxablePaise }], taxMode: inv.taxMode as "intra" | "inter" | "none", gstRateBp: inv.gstRateBp, roundToRupee: seller.roundToRupee });
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
        taxablePaise: t.taxablePaise,
        cgstPaise: t.cgstPaise,
        sgstPaise: t.sgstPaise,
        igstPaise: t.igstPaise,
        totalPaise: t.totalPaise,
        createdById: actorId,
      },
      select: { id: true },
    });
    await recomputeSettlement(tx, inv.id);
    await logSalesEvent(tx, { entityType: "credit_note", entityId: cn.id, actorId, action: "issued", toStatus: "issued", note: `${number} against ${inv.number}` });
    await logSalesEvent(tx, { entityType: "invoice", entityId: inv.id, actorId, action: "credit_note_issued", note: number });
    return cn;
  });
  const [cn] = await listCreditNotes({});
  return cn && cn.id === created.id ? cn : (await listCreditNotes({})).find((c) => c.id === created.id)!;
}

export async function cancelCreditNote(id: string, actorId: string) {
  const cn = await prisma.salesCreditNote.findUnique({ where: { id }, select: { status: true, invoiceId: true, number: true } });
  if (!cn) throw new AppError(404, "NOT_FOUND", "Credit note not found");
  if (cn.status === "cancelled") return;
  await prisma.$transaction(async (tx) => {
    await tx.salesCreditNote.update({ where: { id }, data: { status: "cancelled", cancelledAt: new Date() } });
    await recomputeSettlement(tx, cn.invoiceId);
    await logSalesEvent(tx, { entityType: "credit_note", entityId: id, actorId, action: "cancelled", fromStatus: "issued", toStatus: "cancelled", note: cn.number });
  });
}
