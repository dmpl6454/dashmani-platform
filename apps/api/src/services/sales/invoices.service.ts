import { prisma, Prisma } from "@dashmani/db";
import { companyScope, SALES_COMPANIES, type CompanyKey, computeTotals, registrationFor, type SellerRegistration, GST_STATE_CODES, lineAmountPaise, rupeesInWords, TAX_MODE_LABELS, taxModeFor, todayIST, type InvoiceUpsertInput, type TaxMode } from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { assertMoneyFits, dateToDay, dayToDate, lockInvoices, logSalesEvent, nextDocumentNumber, type Tx } from "./common";
import { assertSameCompany, resolveDocumentTax, type ResolvedTax } from "./documents.service";
import { getSellerProfile, sellerMissingFields, type SellerProfile } from "./settings.service";
import { assertEInvoiceData, cancelEInvoiceFor, needsEInvoice, queueInvoiceEInvoice, registerEInvoice } from "./einvoice.service";

// GST invoices. A draft has no number and may be edited freely; ISSUING assigns the next
// serial of the financial year, freezes the seller and buyer as JSON snapshots and the totals
// as printed, and from then on the document only moves through settlement (payments, TDS,
// credit notes) or cancellation — never edits. Money is integer paise; `paidPaise`,
// `tdsPaise` and `creditedPaise` are maintained by recomputeSettlement, the single writer.

export const invoiceSummarySelect = {
  id: true, companyKey: true, number: true, kind: true, status: true, issueDate: true, dueDate: true, taxMode: true,
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

export async function listInvoices(filter: { status?: string; clientId?: string; q?: string; companyKey?: CompanyKey }) {
  const today = todayIST();
  const term = filter.q?.trim();
  const storedStatus =
    filter.status === "draft" || filter.status === "cancelled" || filter.status === "paid" ? filter.status
    : filter.status && filter.status !== "all" ? "issued" : undefined;
  const rows = await prisma.salesInvoice.findMany({
    where: {
      ...(filter.companyKey ? { companyKey: filter.companyKey } : {}),
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
      allocations: { include: { payment: { select: { id: true, number: true, mode: true, reference: true, paidOn: true, amountPaise: true, tdsPaise: true, status: true } } }, orderBy: { createdAt: "asc" } },
      creditNotes: { orderBy: { createdAt: "asc" }, include: { einvoice: { select: { status: true, irn: true, ackNo: true, ackDate: true, lastError: true } } } },
      einvoice: { select: { id: true, docType: true, gstin: true, status: true, irn: true, ackNo: true, ackDate: true, lastError: true, attempts: true, cancelledAt: true, signedQrCode: true } },
      convertedFrom: { select: { id: true, number: true } },
      conversions: { select: { id: true, number: true, status: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!inv) throw new AppError(404, "NOT_FOUND", "Invoice not found");
  const { client, items, order, allocations, creditNotes, convertedFrom, conversions, einvoice, ...row } = inv;
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
    convertedFrom,
    conversions,
    einvoice,
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
  assertMoneyFits({ subtotalPaise: t.subtotalPaise, taxablePaise: t.taxablePaise, totalPaise: t.totalPaise });
  return {
    subtotalPaise: t.subtotalPaise, discountPaise: t.discountPaise, taxablePaise: t.taxablePaise,
    cgstPaise: t.cgstPaise, sgstPaise: t.sgstPaise, igstPaise: t.igstPaise, roundOffPaise: t.roundOffPaise, totalPaise: t.totalPaise,
  };
}

/** An invoice billed against an order bills it from the order's company. */
async function assertOrderCompany(orderId: string | null | undefined, company: CompanyKey) {
  if (!orderId) return;
  const order = await prisma.salesOrder.findUnique({ where: { id: orderId }, select: { companyKey: true, number: true } });
  if (order && order.companyKey !== company) throw new AppError(409, "COMPANY_MISMATCH", `${order.number} is ${SALES_COMPANIES[order.companyKey as CompanyKey]?.name ?? "the other company"}'s order — invoice it from that company`);
}

export async function createInvoice(input: InvoiceUpsertInput, actorId: string, link: { convertedFromId?: string } = {}) {
  await assertOrderCompany(input.orderId, input.companyKey);
  const tax = await resolveDocumentTax(input.clientId, input, input.companyKey);
  const lines = invoiceLines(input.items, tax.seller.defaultSac);
  const totals = invoiceTotals(lines, input.discountPaise, tax);
  const created = await prisma.salesInvoice.create({
    data: {
      companyKey: input.companyKey,
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
      convertedFromId: link.convertedFromId ?? null,
      createdById: actorId,
      items: { create: lines },
    },
    select: { id: true },
  });
  await logSalesEvent(prisma, { entityType: "invoice", entityId: created.id, actorId, action: "created", toStatus: "draft" });
  return getInvoice(created.id);
}

export async function updateInvoice(id: string, input: InvoiceUpsertInput, actorId: string) {
  const existing = await prisma.salesInvoice.findUnique({ where: { id }, select: { status: true, companyKey: true } });
  if (!existing) throw new AppError(404, "NOT_FOUND", "Invoice not found");
  if (existing.status !== "draft") throw new AppError(409, "INVOICE_LOCKED", "Only a draft invoice can be edited — cancel and re-issue instead");
  assertSameCompany(existing.companyKey, input.companyKey, "invoice");
  await assertOrderCompany(input.orderId, input.companyKey);
  const tax = await resolveDocumentTax(input.clientId, input, input.companyKey);
  const lines = invoiceLines(input.items, tax.seller.defaultSac);
  const totals = invoiceTotals(lines, input.discountPaise, tax);
  await prisma.$transaction(async (tx) => {
    // Re-checked under the lock Issue also takes: an edit can never rewrite an invoice that was
    // issued (numbered, snapshotted, amount in words) a moment earlier from another tab.
    await lockInvoices(tx, [id]);
    const cur = await tx.salesInvoice.findUnique({ where: { id }, select: { status: true } });
    if (!cur) throw new AppError(404, "NOT_FOUND", "Invoice not found");
    if (cur.status !== "draft") throw new AppError(409, "INVOICE_LOCKED", "This invoice was issued a moment ago and can no longer be edited — reload it");
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
  // An order line already on a live invoice (a draft or an issued one) is never billed twice.
  // Deleting the draft or cancelling the invoice frees its lines again.
  const billable = order.items.filter((it) => it.status !== "cancelled");
  const onInvoices = await prisma.salesInvoiceItem.findMany({
    where: { orderItemId: { in: billable.map((it) => it.id) }, invoice: { status: { not: "cancelled" } } },
    select: { orderItemId: true, invoice: { select: { number: true, kind: true } } },
  });
  const taken = new Set(onInvoices.map((r) => r.orderItemId));
  const remaining = billable.filter((it) => !taken.has(it.id));
  if (!remaining.length) {
    const on = onInvoices[0]?.invoice ?? null;
    throw new AppError(409, "ORDER_ALREADY_INVOICED", `Every line of ${order.number} is already on ${on?.number ?? "a draft invoice"} — ${on?.kind === "proforma" && on.number ? "convert that proforma to a tax invoice instead" : "open that invoice instead"}`);
  }
  return createInvoice(
    {
      companyKey: order.companyKey as CompanyKey,
      clientId: order.clientId,
      kind: "tax_invoice",
      orderId: order.id,
      campaignBookingId: order.campaignBookingId,
      placeOfSupplyCode: order.placeOfSupplyCode,
      taxMode: order.taxMode as ResolvedTax["taxMode"],
      gstRateBp: order.gstRateBp,
      // The order-level discount belongs to the first invoice for the order, never to a later one.
      discountPaise: taken.size === 0 ? order.discountPaise : 0,
      notes: `${order.number} — ${order.title}${order.poNumber ? ` · PO ${order.poNumber}` : ""}`,
      items: remaining
        .map((it) => ({ description: it.description, sac: it.sac, quantity: it.quantity, unitPricePaise: it.unitPricePaise, discountPaise: it.discountPaise, orderItemId: it.id })),
    },
    actorId,
  );
}

/** A draft invoice for a client's self-serve campaign booking (frozen item prices). */
export async function createInvoiceFromBooking(bookingId: string, actorId: string, company: CompanyKey = "dspl") {
  const booking = await prisma.campaignBooking.findUnique({ where: { id: bookingId }, include: { items: true } });
  if (!booking) throw new AppError(404, "NOT_FOUND", "Campaign booking not found");
  if (!booking.items.length) throw new AppError(409, "BOOKING_EMPTY", "This booking has no priced accounts yet");
  const existing = await prisma.salesInvoice.findFirst({ where: { campaignBookingId: booking.id, status: { not: "cancelled" } }, select: { number: true } });
  if (existing) throw new AppError(409, "BOOKING_ALREADY_INVOICED", `This booking is already on ${existing.number ?? "a draft invoice"} — open that invoice instead`);
  const labelFormat = (f: string) => f.charAt(0).toUpperCase() + f.slice(1);
  return createInvoice(
    {
      companyKey: company,
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

function sellerSnapshotFor(s: SellerProfile, reg: SellerRegistration) {
  const { invoicePrefix, quotePrefix, orderPrefix, creditNotePrefix, receiptPrefix, defaultSac, defaultGstRateBp, defaultDueDays, roundToRupee, branches, ...printable } = s;
  // The GSTIN and address printed are those of the registration billing this supply.
  return { ...printable, gstin: reg.gstin, stateCode: reg.stateCode, state: reg.state, addressLine1: reg.addressLine1, addressLine2: reg.addressLine2, city: reg.city, pincode: reg.pincode, registration: reg.label };
}

export type SellerSnapshot = ReturnType<typeof sellerSnapshotFor>;

/** Assign the serial, freeze both parties and the totals, and make the document final. */
export async function issueInvoice(
  id: string,
  input: { issueDate?: string; dueDate?: string | null; taxResolution?: "recompute" | "keep" },
  actorId: string,
) {
  // The company never changes after creation, so reading it before the lock is safe.
  const owner = await prisma.salesInvoice.findUnique({ where: { id }, select: { companyKey: true } });
  if (!owner) throw new AppError(404, "NOT_FOUND", "Invoice not found");
  const company = owner.companyKey as CompanyKey;
  const seller = await getSellerProfile(company);
  let einvoiceId: string | null = null;
  await prisma.$transaction(async (tx) => {
    // Everything is read AFTER the row lock. A second Issue (another tab, a retry) waits here and
    // then finds the invoice issued, so it never takes — and wastes — a serial; an edit saved a
    // moment earlier is what gets numbered, never the figures from before it.
    await lockInvoices(tx, [id]);
    const inv = await tx.salesInvoice.findUnique({ where: { id }, include: { items: { orderBy: { position: "asc" } }, client: clientBrief } });
    if (!inv) throw new AppError(404, "NOT_FOUND", "Invoice not found");
    if (inv.status !== "draft") throw new AppError(409, "BAD_TRANSITION", `A ${inv.status} invoice cannot be issued again`);
    const missing = sellerMissingFields(seller);
    if (!seller || (inv.kind === "tax_invoice" && missing.length)) {
      throw new AppError(422, "SELLER_PROFILE_INCOMPLETE", `Complete ${SALES_COMPANIES[company].name}'s GST profile in Settings before issuing a tax invoice`, missing.map((f) => ({ field: f, message: "required" })));
    }
    if (!inv.items.length) throw new AppError(409, "INVOICE_EMPTY", "Add at least one line before issuing");
    const issueDate = input.issueDate ?? todayIST();
    const dueDate = input.dueDate ?? (dateToDay(inv.dueDate) ?? addDays(issueDate, seller.defaultDueDays));
    if (dueDate < issueDate) throw new AppError(422, "DUE_BEFORE_ISSUE", `The due date (${dueDate}) is before the issue date (${issueDate}) — pick a later due date`);

    // The GST type was worked out when the draft was saved. If the company profile or the client's
    // billing state changed since (e.g. drafted before the real profile existed), issuing it as-is
    // would print the wrong tax — and a tax invoice can only be fixed by cancelling it. So a
    // mismatch stops here until staff choose: update it (recompute) or keep it (an SEZ buyer, a
    // deliberate place of supply).
    const buyerProfile = inv.client.billingProfile;
    const expectedPos = buyerProfile?.stateCode ?? inv.placeOfSupplyCode ?? null;
    // The registration this supply is billed from (the client's state if we are registered there).
    const reg = registrationFor(seller, expectedPos);
    const expectedMode = taxModeFor(reg.stateCode, expectedPos, buyerProfile?.country ?? "IN");
    const storedMode = inv.taxMode as TaxMode;
    const taxChanged = expectedMode !== storedMode || expectedPos !== (inv.placeOfSupplyCode ?? null);
    if (taxChanged && !input.taxResolution) {
      const pos = (c: string | null) => (c ? `, place of supply ${c}${GST_STATE_CODES[c] ? ` ${GST_STATE_CODES[c]}` : ""}` : "");
      throw new AppError(
        409,
        "TAX_CHANGED",
        // No `details`: the portal shows an error's first detail INSTEAD of its message.
        `This draft was saved with ${TAX_MODE_LABELS[storedMode]}${pos(inv.placeOfSupplyCode)}, but the company profile and the client's billing details now give ${TAX_MODE_LABELS[expectedMode]}${pos(expectedPos)}. Update the GST, or keep it as drafted if that was deliberate.`,
      );
    }
    const recompute = taxChanged && input.taxResolution === "recompute";

    // Never bill the same work twice: duplicate drafts can exist (two quick "Create invoice"
    // clicks), so the check that counts is here, under a lock on the order / booking row.
    if (inv.orderId) {
      await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${inv.orderId} FOR UPDATE`;
      const lineIds = inv.items.map((it) => it.orderItemId).filter((x): x is string => !!x);
      const clash = lineIds.length
        ? await tx.salesInvoiceItem.findFirst({ where: { orderItemId: { in: lineIds }, invoiceId: { not: id }, invoice: { kind: "tax_invoice", status: { in: ["issued", "paid"] } } }, select: { invoice: { select: { number: true } } } })
        : null;
      if (clash) throw new AppError(409, "ORDER_ALREADY_INVOICED", `Lines on this draft are already billed on ${clash.invoice.number} — delete this draft or remove those lines`);
    }
    if (inv.campaignBookingId) {
      await tx.$queryRaw`SELECT id FROM campaign_bookings WHERE id = ${inv.campaignBookingId} FOR UPDATE`;
      const clash = await tx.salesInvoice.findFirst({ where: { campaignBookingId: inv.campaignBookingId, id: { not: id }, kind: "tax_invoice", status: { in: ["issued", "paid"] } }, select: { number: true } });
      if (clash) throw new AppError(409, "BOOKING_ALREADY_INVOICED", `This booking is already billed on ${clash.number} — delete this draft`);
    }

    let totalPaise = inv.totalPaise;
    let taxData: Prisma.SalesInvoiceUpdateInput = {};
    if (recompute) {
      const t = computeTotals({
        lines: inv.items.map((it) => ({ quantity: it.quantity, unitPricePaise: it.unitPricePaise, discountPaise: it.discountPaise })),
        discountPaise: inv.discountPaise,
        taxMode: expectedMode,
        gstRateBp: inv.gstRateBp,
        roundToRupee: seller.roundToRupee,
      });
      assertMoneyFits({ subtotalPaise: t.subtotalPaise, taxablePaise: t.taxablePaise, totalPaise: t.totalPaise });
      totalPaise = t.totalPaise;
      taxData = {
        placeOfSupplyCode: expectedPos, taxMode: expectedMode,
        subtotalPaise: t.subtotalPaise, discountPaise: t.discountPaise, taxablePaise: t.taxablePaise,
        cgstPaise: t.cgstPaise, sgstPaise: t.sgstPaise, igstPaise: t.igstPaise, roundOffPaise: t.roundOffPaise, totalPaise: t.totalPaise,
      };
    }
    // E-invoicing: check the data the IRP needs BEFORE a serial is taken.
    const buyerSnap = buyerSnapshotFor(inv.client as Parameters<typeof buyerSnapshotFor>[0]);
    const sellerSnap = sellerSnapshotFor(seller, reg);
    const wantsIrn = inv.kind === "tax_invoice" && needsEInvoice(seller, buyerSnap, issueDate);
    if (wantsIrn) assertEInvoiceData(sellerSnap, buyerSnap);
    // Proformas are not tax invoices: their own PI series, so the tax-invoice serials stay consecutive.
    const number = inv.kind === "proforma"
      ? await nextDocumentNumber(tx, "proforma", SALES_COMPANIES[company].proformaPrefix, issueDate, companyScope(company, null))
      : await nextDocumentNumber(tx, "invoice", reg.invoicePrefix, issueDate, companyScope(company, reg.scope));
    await tx.salesInvoice.update({
      where: { id },
      data: {
        ...taxData,
        number,
        status: "issued",
        issueDate: dayToDate(issueDate),
        dueDate: dayToDate(dueDate),
        issuedAt: new Date(),
        sellerSnapshot: sellerSnap as Prisma.InputJsonValue,
        buyerSnapshot: buyerSnap as Prisma.InputJsonValue,
        amountInWords: rupeesInWords(totalPaise),
        terms: inv.terms ?? seller.terms ?? null,
      },
    });
    const taxNote = !taxChanged ? "" : recompute ? ` · GST updated to ${TAX_MODE_LABELS[expectedMode]}` : ` · GST kept as drafted (${TAX_MODE_LABELS[storedMode]})`;
    await logSalesEvent(tx, { entityType: "invoice", entityId: id, actorId, action: "issued", fromStatus: "draft", toStatus: "issued", note: `${number}${taxNote}` });
    if (wantsIrn) einvoiceId = await queueInvoiceEInvoice(tx, id);

    // A tax invoice converted from a proforma takes over the proforma's payments; the proforma is
    // then cancelled ("Converted to …"), so the money is counted once, on the real bill. Anything
    // the payments exceed this invoice by goes back to the receipts as unapplied credit.
    if (inv.convertedFromId) {
      await lockInvoices(tx, [inv.convertedFromId]);
      const pf = await tx.salesInvoice.findUnique({ where: { id: inv.convertedFromId }, select: { id: true, number: true, kind: true, status: true } });
      if (pf && pf.kind === "proforma" && pf.status !== "cancelled") {
        const moving = await tx.salesPaymentAllocation.findMany({ where: { invoiceId: pf.id } });
        for (const a of moving) {
          const already = await tx.salesPaymentAllocation.findUnique({ where: { paymentId_invoiceId: { paymentId: a.paymentId, invoiceId: id } } });
          if (already) {
            await tx.salesPaymentAllocation.update({ where: { id: already.id }, data: { amountPaise: { increment: a.amountPaise }, tdsPaise: { increment: a.tdsPaise } } });
            await tx.salesPaymentAllocation.delete({ where: { id: a.id } });
          } else {
            await tx.salesPaymentAllocation.update({ where: { id: a.id }, data: { invoiceId: id } });
          }
        }
        await releaseExcess(tx, id, actorId);
        await recomputeSettlement(tx, id);
        await tx.salesInvoice.update({
          where: { id: pf.id },
          data: { status: "cancelled", cancelledAt: new Date(), cancelReason: `Converted to tax invoice ${number}`, paidPaise: 0, tdsPaise: 0, creditedPaise: 0, paidAt: null },
        });
        await logSalesEvent(tx, { entityType: "invoice", entityId: pf.id, actorId, action: "converted", fromStatus: pf.status, toStatus: "cancelled", note: `Converted to ${number}${moving.length ? ` · ${moving.length} payment(s) moved` : ""}` });
      }
    }
  });
  // After commit: register on the IRP. A portal failure is recorded on the e-invoice row (visible,
  // retryable) and never undoes the issued invoice.
  if (einvoiceId) await registerEInvoice(einvoiceId, actorId);
  return getInvoice(id);
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export async function cancelInvoice(id: string, reason: string, actorId: string) {
  // A registered IRN is cancelled on the IRP first (24-hour window), and only for an invoice that
  // could be cancelled at all (issued, nothing settled against it).
  const pre = await prisma.salesInvoice.findUnique({ where: { id }, select: { status: true, paidPaise: true, tdsPaise: true, creditedPaise: true } });
  if (pre && pre.status !== "draft" && pre.status !== "cancelled" && pre.paidPaise + pre.tdsPaise + pre.creditedPaise === 0) {
    await cancelEInvoiceFor({ invoiceId: id }, reason, actorId);
  }
  // Decided under the row lock, so a payment or credit note landing at the same moment either
  // goes first (and the cancel is refused) or finds the invoice cancelled (and is refused).
  const outcome = await prisma.$transaction(async (tx) => {
    await lockInvoices(tx, [id]);
    const inv = await tx.salesInvoice.findUnique({ where: { id }, select: { status: true, paidPaise: true, tdsPaise: true, creditedPaise: true } });
    if (!inv) throw new AppError(404, "NOT_FOUND", "Invoice not found");
    if (inv.status === "cancelled") return "unchanged" as const;
    if (inv.status === "draft") {
      await tx.salesInvoice.delete({ where: { id } });
      return "deleted" as const;
    }
    if (inv.paidPaise + inv.tdsPaise + inv.creditedPaise > 0) {
      throw new AppError(409, "INVOICE_SETTLED", "This invoice has payments or credit notes against it — issue a credit note instead of cancelling");
    }
    await tx.salesInvoice.update({ where: { id }, data: { status: "cancelled", cancelledAt: new Date(), cancelReason: reason } });
    await logSalesEvent(tx, { entityType: "invoice", entityId: id, actorId, action: "cancelled", fromStatus: inv.status, toStatus: "cancelled", note: reason });
    return "cancelled" as const;
  });
  return outcome === "deleted" ? null : getInvoice(id);
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
    // A voided receipt's allocations stay on record but no longer settle anything.
    tx.salesPaymentAllocation.aggregate({ where: { invoiceId, payment: { status: "recorded" } }, _sum: { amountPaise: true, tdsPaise: true } }),
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

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * If an invoice is settled beyond its total (a credit note after it was paid, or a converted
 * proforma's payments exceeding the tax invoice), give the excess back to the receipts it came
 * from — newest allocation first, cash before TDS — so it shows as the client's unapplied credit
 * (apply it to another invoice, or refund it). Call under the invoice lock, then recomputeSettlement.
 */
export async function releaseExcess(tx: Tx, invoiceId: string, actorId: string): Promise<number> {
  const inv = await tx.salesInvoice.findUnique({ where: { id: invoiceId }, select: { totalPaise: true, number: true } });
  if (!inv) return 0;
  const [allocs, credits] = await Promise.all([
    tx.salesPaymentAllocation.findMany({ where: { invoiceId, payment: { status: "recorded" } }, orderBy: { createdAt: "desc" }, include: { payment: { select: { id: true, number: true } } } }),
    tx.salesCreditNote.aggregate({ where: { invoiceId, status: "issued" }, _sum: { totalPaise: true } }),
  ]);
  let excess = allocs.reduce((s, a) => s + a.amountPaise + a.tdsPaise, 0) + (credits._sum.totalPaise ?? 0) - inv.totalPaise;
  let released = 0;
  for (const a of allocs) {
    if (excess <= 0) break;
    const cash = Math.min(a.amountPaise, excess);
    const tds = Math.min(a.tdsPaise, excess - cash);
    if (cash + tds === 0) continue;
    excess -= cash + tds;
    released += cash + tds;
    if (a.amountPaise === cash && a.tdsPaise === tds) await tx.salesPaymentAllocation.delete({ where: { id: a.id } });
    else await tx.salesPaymentAllocation.update({ where: { id: a.id }, data: { amountPaise: { decrement: cash }, tdsPaise: { decrement: tds } } });
    await logSalesEvent(tx, { entityType: "payment", entityId: a.payment.id, actorId, action: "allocation_released", note: `${rupees(cash + tds)} back from ${inv.number ?? "an invoice"}` });
  }
  if (released) await logSalesEvent(tx, { entityType: "invoice", entityId: invoiceId, actorId, action: "excess_released", note: `${rupees(released)} returned to the receipts as unapplied credit` });
  return released;
}

/**
 * Turn an issued proforma into a draft TAX invoice with the same lines, client and GST. Issuing
 * that draft takes the next tax-invoice serial, moves the proforma's payments onto it and cancels
 * the proforma ("Converted to …"). One live conversion per proforma.
 */
export async function convertProforma(id: string, actorId: string) {
  const pf = await prisma.salesInvoice.findUnique({ where: { id }, include: { items: { orderBy: { position: "asc" } } } });
  if (!pf) throw new AppError(404, "NOT_FOUND", "Invoice not found");
  if (pf.kind !== "proforma") throw new AppError(409, "NOT_PROFORMA", "Only a proforma can be converted to a tax invoice");
  if (pf.status !== "issued" && pf.status !== "paid") throw new AppError(409, "BAD_TRANSITION", `A ${pf.status} proforma cannot be converted`);
  const existing = await prisma.salesInvoice.findFirst({ where: { convertedFromId: id, status: { not: "cancelled" } }, select: { id: true, number: true } });
  if (existing) throw new AppError(409, "ALREADY_CONVERTED", `This proforma is already on ${existing.number ?? "a draft tax invoice"} — open that invoice instead`);
  const draft = await createInvoice(
    {
      companyKey: pf.companyKey as CompanyKey,
      clientId: pf.clientId,
      kind: "tax_invoice",
      orderId: pf.orderId,
      campaignBookingId: pf.campaignBookingId,
      placeOfSupplyCode: pf.placeOfSupplyCode,
      taxMode: pf.taxMode as TaxMode,
      gstRateBp: pf.gstRateBp,
      discountPaise: pf.discountPaise,
      notes: `Against proforma ${pf.number}${pf.notes ? ` — ${pf.notes}` : ""}`,
      terms: pf.terms,
      internalNotes: pf.internalNotes,
      items: pf.items.map((it) => ({ description: it.description, sac: it.sac, quantity: it.quantity, unitPricePaise: it.unitPricePaise, discountPaise: it.discountPaise, orderItemId: it.orderItemId })),
    },
    actorId,
    { convertedFromId: pf.id },
  );
  await logSalesEvent(prisma, { entityType: "invoice", entityId: pf.id, actorId, action: "conversion_drafted", note: "Draft tax invoice created" });
  return draft;
}
