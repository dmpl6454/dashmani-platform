import { prisma, Prisma } from "@dashmani/db";
import { computeTotals, lineAmountPaise, rupeesInWords, todayIST, type InvoiceUpsertInput } from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { dateToDay, dayToDate, logSalesEvent, nextDocumentNumber, type Tx } from "./common";
import { resolveDocumentTax, type ResolvedTax } from "./documents.service";
import { getSellerProfile, sellerMissingFields, type SellerProfile } from "./settings.service";

// GST invoices. A draft has no number and may be edited freely; ISSUING assigns the next
// serial of the financial year, freezes the seller and buyer as JSON snapshots and the totals
// as printed, and from then on the document only moves through settlement (payments, TDS,
// credit notes) or cancellation — never edits. Money is integer paise; `paidPaise`,
// `tdsPaise` and `creditedPaise` are maintained by recomputeSettlement, the single writer.

export const invoiceSummarySelect = {
  id: true, number: true, kind: true, status: true, issueDate: true, dueDate: true, taxMode: true,
  subtotalPaise: true, discountPaise: true, taxablePaise: true, cgstPaise: true, sgstPaise: true, igstPaise: true, roundOffPaise: true,
  totalPaise: true, paidPaise: true, tdsPaise: true, creditedPaise: true, clientId: true, orderId: true, campaignBookingId: true,
  issuedAt: true, sentAt: true, paidAt: true, cancelledAt: true, createdAt: true,
} as const;

type InvoiceSummaryRow = Prisma.SalesInvoiceGetPayload<{ select: typeof invoiceSummarySelect }>;

export type DerivedInvoiceStatus = "draft" | "issued" | "partially_paid" | "paid" | "overdue" | "cancelled";

/** Balance and the status the UI shows (partially paid / overdue are facts, not stored states). */
export function deriveInvoice<T extends InvoiceSummaryRow>(inv: T, today: string) {
  const settled = inv.paidPaise + inv.tdsPaise + inv.creditedPaise;
  const balancePaise = Math.max(0, inv.totalPaise - settled);
  let derivedStatus: DerivedInvoiceStatus;
  if (inv.status === "cancelled") derivedStatus = "cancelled";
  else if (inv.status === "draft") derivedStatus = "draft";
  else if (inv.status === "paid" || balancePaise === 0) derivedStatus = "paid";
  else if (settled > 0) derivedStatus = "partially_paid";
  else derivedStatus = "issued";
  const due = dateToDay(inv.dueDate);
  if ((derivedStatus === "issued" || derivedStatus === "partially_paid") && due && due < today) derivedStatus = "overdue";
  return { ...inv, issueDate: dateToDay(inv.issueDate), dueDate: due, balancePaise, derivedStatus };
}

const clientBrief = {
  select: {
    id: true, companyName: true, contactName: true, email: true, phone: true,
    billingProfile: { select: { legalName: true, gstin: true, pan: true, addressLine1: true, addressLine2: true, city: true, state: true, stateCode: true, pincode: true, country: true, billingEmail: true } },
  },
};

export async function listInvoices(filter: { status?: string; clientId?: string; q?: string }) {
  const today = todayIST();
  const term = filter.q?.trim();
  const storedStatus =
    filter.status === "draft" || filter.status === "cancelled" || filter.status === "paid" ? filter.status
    : filter.status && filter.status !== "all" ? "issued" : undefined;
  const rows = await prisma.salesInvoice.findMany({
    where: {
      ...(filter.clientId ? { clientId: filter.clientId } : {}),
      ...(storedStatus ? { status: storedStatus } : {}),
      ...(term ? { OR: [{ number: { contains: term, mode: "insensitive" } }, { client: { companyName: { contains: term, mode: "insensitive" } } }] } : {}),
    },
    orderBy: [{ createdAt: "desc" }],
    take: 500,
    select: { ...invoiceSummarySelect, client: { select: { id: true, companyName: true, billingProfile: { select: { legalName: true } } } } },
  });
  const derived = rows.map((r) => deriveInvoice(r, today));
  if (filter.status === "outstanding") return derived.filter((i) => ["issued", "partially_paid", "overdue"].includes(i.derivedStatus));
  if (filter.status === "overdue" || filter.status === "partially_paid" || filter.status === "issued") return derived.filter((i) => i.derivedStatus === filter.status);
  return derived;
}

export async function getInvoice(id: string) {
  const inv = await prisma.salesInvoice.findUnique({
    where: { id },
    include: {
      client: clientBrief,
      items: { orderBy: { position: "asc" } },
      order: { select: { id: true, number: true, title: true } },
      allocations: { include: { payment: { select: { id: true, number: true, mode: true, reference: true, paidOn: true, amountPaise: true, tdsPaise: true } } }, orderBy: { createdAt: "asc" } },
      creditNotes: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!inv) throw new AppError(404, "NOT_FOUND", "Invoice not found");
  const { client, items, order, allocations, creditNotes, ...row } = inv;
  return {
    ...deriveInvoice(row, todayIST()),
    sellerSnapshot: row.sellerSnapshot,
    buyerSnapshot: row.buyerSnapshot,
    amountInWords: row.amountInWords,
    notes: row.notes,
    terms: row.terms,
    internalNotes: row.internalNotes,
    cancelReason: row.cancelReason,
    gstRateBp: row.gstRateBp,
    placeOfSupplyCode: row.placeOfSupplyCode,
    client,
    order,
    items,
    allocations: allocations.map((a) => ({ ...a, payment: { ...a.payment, paidOn: dateToDay(a.payment.paidOn) } })),
    creditNotes: creditNotes.map((c) => ({ ...c, issueDate: dateToDay(c.issueDate) })),
  };
}

export type InvoiceView = Awaited<ReturnType<typeof getInvoice>>;

function invoiceLines(items: InvoiceUpsertInput["items"], defaultSac: string) {
  return items.map((it, position) => ({
    position,
    description: it.description,
    sac: it.sac ?? defaultSac,
    quantity: it.quantity,
    unitPricePaise: it.unitPricePaise,
    discountPaise: it.discountPaise,
    amountPaise: lineAmountPaise(it),
    orderItemId: it.orderItemId ?? null,
  }));
}

function invoiceTotals(lines: Array<{ quantity: number; unitPricePaise: number; discountPaise: number }>, discountPaise: number, tax: ResolvedTax) {
  const t = computeTotals({ lines, discountPaise, taxMode: tax.taxMode, gstRateBp: tax.gstRateBp, roundToRupee: tax.seller.roundToRupee });
  return {
    subtotalPaise: t.subtotalPaise, discountPaise: t.discountPaise, taxablePaise: t.taxablePaise,
    cgstPaise: t.cgstPaise, sgstPaise: t.sgstPaise, igstPaise: t.igstPaise, roundOffPaise: t.roundOffPaise, totalPaise: t.totalPaise,
  };
}

export async function createInvoice(input: InvoiceUpsertInput, actorId: string) {
  const tax = await resolveDocumentTax(input.clientId, input);
  const lines = invoiceLines(input.items, tax.seller.defaultSac);
  const totals = invoiceTotals(lines, input.discountPaise, tax);
  const created = await prisma.salesInvoice.create({
    data: {
      kind: input.kind,
      clientId: input.clientId,
      orderId: input.orderId ?? null,
      campaignBookingId: input.campaignBookingId ?? null,
      issueDate: input.issueDate ? dayToDate(input.issueDate) : null,
      dueDate: input.dueDate ? dayToDate(input.dueDate) : null,
      placeOfSupplyCode: tax.placeOfSupplyCode,
      taxMode: tax.taxMode,
      gstRateBp: tax.gstRateBp,
      ...totals,
      notes: input.notes ?? null,
      terms: input.terms ?? tax.seller.terms ?? null,
      internalNotes: input.internalNotes ?? null,
      createdById: actorId,
      items: { create: lines },
    },
    select: { id: true },
  });
  await logSalesEvent(prisma, { entityType: "invoice", entityId: created.id, actorId, action: "created", toStatus: "draft" });
  return getInvoice(created.id);
}

export async function updateInvoice(id: string, input: InvoiceUpsertInput, actorId: string) {
  const existing = await prisma.salesInvoice.findUnique({ where: { id }, select: { status: true } });
  if (!existing) throw new AppError(404, "NOT_FOUND", "Invoice not found");
  if (existing.status !== "draft") throw new AppError(409, "INVOICE_LOCKED", "Only a draft invoice can be edited — cancel and re-issue instead");
  const tax = await resolveDocumentTax(input.clientId, input);
  const lines = invoiceLines(input.items, tax.seller.defaultSac);
  const totals = invoiceTotals(lines, input.discountPaise, tax);
  await prisma.$transaction(async (tx) => {
    await tx.salesInvoiceItem.deleteMany({ where: { invoiceId: id } });
    await tx.salesInvoice.update({
      where: { id },
      data: {
        kind: input.kind,
        clientId: input.clientId,
        orderId: input.orderId ?? null,
        campaignBookingId: input.campaignBookingId ?? null,
        issueDate: input.issueDate ? dayToDate(input.issueDate) : null,
        dueDate: input.dueDate ? dayToDate(input.dueDate) : null,
        placeOfSupplyCode: tax.placeOfSupplyCode,
        taxMode: tax.taxMode,
        gstRateBp: tax.gstRateBp,
        ...totals,
        notes: input.notes ?? null,
        terms: input.terms ?? null,
        internalNotes: input.internalNotes ?? null,
        items: { create: lines },
      },
    });
    await logSalesEvent(tx, { entityType: "invoice", entityId: id, actorId, action: "updated" });
  });
  return getInvoice(id);
}

/** A draft invoice for every line of an order (one invoice per order is the common case). */
export async function createInvoiceFromOrder(orderId: string, actorId: string) {
  const order = await prisma.salesOrder.findUnique({ where: { id: orderId }, include: { items: { orderBy: { position: "asc" } } } });
  if (!order) throw new AppError(404, "NOT_FOUND", "Order not found");
  if (order.status === "cancelled" || order.status === "draft") throw new AppError(409, "ORDER_NOT_BILLABLE", `A ${order.status} order cannot be invoiced`);
  return createInvoice(
    {
      clientId: order.clientId,
      kind: "tax_invoice",
      orderId: order.id,
      campaignBookingId: order.campaignBookingId,
      placeOfSupplyCode: order.placeOfSupplyCode,
      taxMode: order.taxMode as ResolvedTax["taxMode"],
      gstRateBp: order.gstRateBp,
      discountPaise: order.discountPaise,
      notes: `${order.number} — ${order.title}${order.poNumber ? ` · PO ${order.poNumber}` : ""}`,
      items: order.items
        .filter((it) => it.status !== "cancelled")
        .map((it) => ({ description: it.description, sac: it.sac, quantity: it.quantity, unitPricePaise: it.unitPricePaise, discountPaise: it.discountPaise, orderItemId: it.id })),
    },
    actorId,
  );
}

/** A draft invoice for a client's self-serve campaign booking (frozen item prices). */
export async function createInvoiceFromBooking(bookingId: string, actorId: string) {
  const booking = await prisma.campaignBooking.findUnique({ where: { id: bookingId }, include: { items: true } });
  if (!booking) throw new AppError(404, "NOT_FOUND", "Campaign booking not found");
  if (!booking.items.length) throw new AppError(409, "BOOKING_EMPTY", "This booking has no priced accounts yet");
  const labelFormat = (f: string) => f.charAt(0).toUpperCase() + f.slice(1);
  return createInvoice(
    {
      clientId: booking.clientId,
      kind: "tax_invoice",
      campaignBookingId: booking.id,
      discountPaise: 0,
      notes: `Campaign "${booking.name}" for ${booking.brand}`,
      items: booking.items
        .filter((it) => it.status !== "cancelled" && it.status !== "refunded")
        .map((it) => ({
          description: `${it.accountName}${it.accountHandle ? ` (@${it.accountHandle})` : ""} · ${labelFormat(it.platform)} ${labelFormat(it.format)}`,
          quantity: 1,
          unitPricePaise: it.pricePaise,
          discountPaise: 0,
        })),
    },
    actorId,
  );
}

function buyerSnapshotFor(client: NonNullable<Awaited<ReturnType<typeof getInvoice>>["client"]>) {
  const p = client.billingProfile;
  return {
    legalName: p?.legalName ?? client.companyName,
    companyName: client.companyName,
    contactName: client.contactName,
    email: p?.billingEmail ?? client.email,
    phone: client.phone,
    gstin: p?.gstin ?? null,
    pan: p?.pan ?? null,
    addressLine1: p?.addressLine1 ?? null,
    addressLine2: p?.addressLine2 ?? null,
    city: p?.city ?? null,
    state: p?.state ?? null,
    stateCode: p?.stateCode ?? null,
    pincode: p?.pincode ?? null,
    country: p?.country ?? "IN",
  };
}

export type BuyerSnapshot = ReturnType<typeof buyerSnapshotFor>;

function sellerSnapshotFor(s: SellerProfile) {
  const { invoicePrefix, quotePrefix, orderPrefix, creditNotePrefix, receiptPrefix, defaultSac, defaultGstRateBp, defaultDueDays, roundToRupee, ...printable } = s;
  return printable;
}

export type SellerSnapshot = ReturnType<typeof sellerSnapshotFor>;

/** Assign the serial, freeze both parties and the totals, and make the document final. */
export async function issueInvoice(id: string, input: { issueDate?: string; dueDate?: string | null }, actorId: string) {
  const inv = await getInvoice(id);
  if (inv.status !== "draft") throw new AppError(409, "BAD_TRANSITION", `A ${inv.status} invoice cannot be issued again`);
  const seller = await getSellerProfile();
  const missing = sellerMissingFields(seller);
  if (!seller || (inv.kind === "tax_invoice" && missing.length)) {
    throw new AppError(422, "SELLER_PROFILE_INCOMPLETE", "Complete the company GST profile in Settings before issuing a tax invoice", missing.map((f) => ({ field: f, message: "required" })));
  }
  if (!inv.items.length) throw new AppError(409, "INVOICE_EMPTY", "Add at least one line before issuing");
  const issueDate = input.issueDate ?? todayIST();
  const dueDate = input.dueDate ?? (inv.dueDate ?? addDays(issueDate, seller.defaultDueDays));
  const buyer = buyerSnapshotFor(inv.client);
  await prisma.$transaction(async (tx) => {
    const number = await nextDocumentNumber(tx, "invoice", inv.kind === "proforma" ? `PI` : seller.invoicePrefix, issueDate);
    await tx.salesInvoice.update({
      where: { id },
      data: {
        number,
        status: "issued",
        issueDate: dayToDate(issueDate),
        dueDate: dayToDate(dueDate),
        issuedAt: new Date(),
        sellerSnapshot: sellerSnapshotFor(seller) as Prisma.InputJsonValue,
        buyerSnapshot: buyer as Prisma.InputJsonValue,
        amountInWords: rupeesInWords(inv.totalPaise),
        terms: inv.terms ?? seller.terms ?? null,
      },
    });
    await logSalesEvent(tx, { entityType: "invoice", entityId: id, actorId, action: "issued", fromStatus: "draft", toStatus: "issued", note: number });
  });
  return getInvoice(id);
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export async function cancelInvoice(id: string, reason: string, actorId: string) {
  const inv = await prisma.salesInvoice.findUnique({ where: { id }, select: { status: true, paidPaise: true, tdsPaise: true, creditedPaise: true } });
  if (!inv) throw new AppError(404, "NOT_FOUND", "Invoice not found");
  if (inv.status === "cancelled") return getInvoice(id);
  if (inv.status === "draft") {
    await prisma.salesInvoice.delete({ where: { id } });
    return null;
  }
  if (inv.paidPaise + inv.tdsPaise + inv.creditedPaise > 0) {
    throw new AppError(409, "INVOICE_SETTLED", "This invoice has payments or credit notes against it — issue a credit note instead of cancelling");
  }
  await prisma.$transaction(async (tx) => {
    await tx.salesInvoice.update({ where: { id }, data: { status: "cancelled", cancelledAt: new Date(), cancelReason: reason } });
    await logSalesEvent(tx, { entityType: "invoice", entityId: id, actorId, action: "cancelled", fromStatus: inv.status, toStatus: "cancelled", note: reason });
  });
  return getInvoice(id);
}

export async function markInvoiceSent(id: string, actorId: string) {
  const inv = await prisma.salesInvoice.findUnique({ where: { id }, select: { status: true } });
  if (!inv) throw new AppError(404, "NOT_FOUND", "Invoice not found");
  if (inv.status === "draft") throw new AppError(409, "BAD_TRANSITION", "Issue the invoice before marking it sent");
  await prisma.salesInvoice.update({ where: { id }, data: { sentAt: new Date() } });
  await logSalesEvent(prisma, { entityType: "invoice", entityId: id, actorId, action: "sent" });
  return getInvoice(id);
}

/**
 * The single writer of paidPaise / tdsPaise / creditedPaise and of the issued→paid flip. Call
 * inside the transaction that changed an allocation or credit note.
 */
export async function recomputeSettlement(tx: Tx, invoiceId: string): Promise<void> {
  const [alloc, credits, inv] = await Promise.all([
    tx.salesPaymentAllocation.aggregate({ where: { invoiceId }, _sum: { amountPaise: true, tdsPaise: true } }),
    tx.salesCreditNote.aggregate({ where: { invoiceId, status: "issued" }, _sum: { totalPaise: true } }),
    tx.salesInvoice.findUnique({ where: { id: invoiceId }, select: { status: true, totalPaise: true, paidAt: true } }),
  ]);
  if (!inv || inv.status === "draft" || inv.status === "cancelled") return;
  const paidPaise = alloc._sum.amountPaise ?? 0;
  const tdsPaise = alloc._sum.tdsPaise ?? 0;
  const creditedPaise = credits._sum.totalPaise ?? 0;
  const settled = paidPaise + tdsPaise + creditedPaise >= inv.totalPaise;
  await tx.salesInvoice.update({
    where: { id: invoiceId },
    data: {
      paidPaise,
      tdsPaise,
      creditedPaise,
      status: settled ? "paid" : "issued",
      paidAt: settled ? (inv.paidAt ?? new Date()) : null,
    },
  });
}
