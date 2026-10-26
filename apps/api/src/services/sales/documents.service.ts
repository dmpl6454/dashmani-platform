import { prisma } from "@dashmani/db";
import { computeTotals, lineAmountPaise, taxModeFor, todayIST, type LineItemInput, type OrderUpsertInput, type QuoteUpsertInput, type TaxMode, registrationFor } from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { assertMoneyFits, dateToDay, dayToDate, logSalesEvent, nextDocumentNumber, type Tx } from "./common";
import { getSellerOrDefaults, type SellerProfile } from "./settings.service";

// Quotes and sales orders. Both carry the same line shape and the same tax resolution; an
// order is a quote that was agreed (or a deal written up directly). Totals are recomputed on
// every save from the lines — never trusted from the client.

const clientBrief = { select: { id: true, companyName: true, contactName: true, email: true, billingProfile: { select: { legalName: true, gstin: true, stateCode: true, country: true } } } };

export interface ResolvedTax {
  seller: SellerProfile;
  placeOfSupplyCode: string | null;
  taxMode: TaxMode;
  gstRateBp: number;
}

export async function resolveDocumentTax(
  clientId: string,
  input: { placeOfSupplyCode?: string | null; taxMode?: TaxMode; gstRateBp?: number },
): Promise<ResolvedTax> {
  const [seller, client] = await Promise.all([
    getSellerOrDefaults(),
    prisma.client.findUnique({ where: { id: clientId }, select: { id: true, billingProfile: { select: { stateCode: true, country: true } } } }),
  ]);
  if (!client) throw new AppError(404, "NOT_FOUND", "Client not found");
  const placeOfSupplyCode = input.placeOfSupplyCode ?? client.billingProfile?.stateCode ?? null;
  const taxMode = input.taxMode ?? taxModeFor(registrationFor(seller, placeOfSupplyCode).stateCode, placeOfSupplyCode, client.billingProfile?.country ?? "IN");
  const gstRateBp = input.gstRateBp ?? seller.defaultGstRateBp;
  return { seller, placeOfSupplyCode, taxMode, gstRateBp };
}

export function buildLines(items: LineItemInput[], defaultSac: string) {
  return items.map((it, position) => ({
    position,
    kind: it.kind,
    targetType: it.targetType ?? null,
    targetId: it.targetId ?? null,
    platform: it.platform ?? null,
    format: it.format ?? null,
    description: it.description,
    accountName: it.accountName ?? null,
    accountHandle: it.accountHandle ?? null,
    quantity: it.quantity,
    unitPricePaise: it.unitPricePaise,
    discountPaise: it.discountPaise,
    amountPaise: lineAmountPaise(it),
    sac: it.sac ?? defaultSac,
    scheduledOn: it.scheduledOn ? dayToDate(it.scheduledOn) : null,
    rateCardId: it.rateCardId ?? null,
  }));
}

function documentTotals(lines: Array<{ quantity: number; unitPricePaise: number; discountPaise: number }>, discountPaise: number, tax: ResolvedTax) {
  const t = computeTotals({ lines, discountPaise, taxMode: tax.taxMode, gstRateBp: tax.gstRateBp, roundToRupee: false });
  assertMoneyFits({ subtotalPaise: t.subtotalPaise, taxablePaise: t.taxablePaise, totalPaise: t.totalPaise });
  return {
    subtotalPaise: t.subtotalPaise,
    discountPaise: t.discountPaise,
    taxablePaise: t.taxablePaise,
    cgstPaise: t.cgstPaise,
    sgstPaise: t.sgstPaise,
    igstPaise: t.igstPaise,
    totalPaise: t.totalPaise,
  };
}

const shapeItem = <T extends { scheduledOn: Date | null }>(i: T) => ({ ...i, scheduledOn: dateToDay(i.scheduledOn) });

// ── Quotes ──────────────────────────────────────────────────────────────────────

const QUOTE_TRANSITIONS: Record<string, { from: string[]; to: string; stamp?: "sentAt" | "acceptedAt" | "declinedAt" }> = {
  send: { from: ["draft"], to: "sent", stamp: "sentAt" },
  accept: { from: ["draft", "sent"], to: "accepted", stamp: "acceptedAt" },
  decline: { from: ["draft", "sent"], to: "declined", stamp: "declinedAt" },
  reopen: { from: ["declined", "expired"], to: "draft" },
};

function quoteExpired(q: { status: string; validUntil: Date | null }, today: string): boolean {
  const until = dateToDay(q.validUntil);
  return !!until && until < today && (q.status === "draft" || q.status === "sent");
}

export async function listQuotes(filter: { status?: string; clientId?: string; q?: string }) {
  const today = todayIST();
  const term = filter.q?.trim();
  const rows = await prisma.salesQuote.findMany({
    where: {
      ...(filter.clientId ? { clientId: filter.clientId } : {}),
      ...(filter.status && filter.status !== "expired" ? { status: filter.status } : {}),
      ...(term ? { OR: [{ number: { contains: term, mode: "insensitive" } }, { title: { contains: term, mode: "insensitive" } }, { client: { companyName: { contains: term, mode: "insensitive" } } }] } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 500,
    include: { client: clientBrief, _count: { select: { items: true } } },
  });
  const shaped = rows.map((q) => ({ ...q, validUntil: dateToDay(q.validUntil), expired: quoteExpired(q, today), itemCount: q._count.items }));
  return filter.status === "expired" ? shaped.filter((q) => q.expired) : shaped;
}

export async function getQuote(id: string) {
  const q = await prisma.salesQuote.findUnique({ where: { id }, include: { client: clientBrief, items: { orderBy: { position: "asc" } } } });
  if (!q) throw new AppError(404, "NOT_FOUND", "Quote not found");
  return { ...q, validUntil: dateToDay(q.validUntil), expired: quoteExpired(q, todayIST()), items: q.items.map(shapeItem) };
}

export async function createQuote(input: QuoteUpsertInput, actorId: string) {
  const tax = await resolveDocumentTax(input.clientId, input);
  const lines = buildLines(input.items, tax.seller.defaultSac);
  const totals = documentTotals(lines, input.discountPaise, tax);
  const created = await prisma.$transaction(async (tx) => {
    const number = await nextDocumentNumber(tx, "quote", tax.seller.quotePrefix, todayIST());
    const q = await tx.salesQuote.create({
      data: {
        number,
        clientId: input.clientId,
        title: input.title,
        campaignType: input.campaignType,
        validUntil: input.validUntil ? dayToDate(input.validUntil) : null,
        placeOfSupplyCode: tax.placeOfSupplyCode,
        taxMode: tax.taxMode,
        gstRateBp: tax.gstRateBp,
        ...totals,
        notes: input.notes ?? null,
        internalNotes: input.internalNotes ?? null,
        createdById: actorId,
        items: { create: lines },
      },
      select: { id: true },
    });
    await logSalesEvent(tx, { entityType: "quote", entityId: q.id, actorId, action: "created", toStatus: "draft" });
    return q;
  });
  return getQuote(created.id);
}

export async function updateQuote(id: string, input: QuoteUpsertInput, actorId: string) {
  const existing = await prisma.salesQuote.findUnique({ where: { id }, select: { status: true, clientId: true } });
  if (!existing) throw new AppError(404, "NOT_FOUND", "Quote not found");
  if (existing.status !== "draft" && existing.status !== "sent") throw new AppError(409, "QUOTE_LOCKED", `A ${existing.status} quote cannot be edited`);
  const tax = await resolveDocumentTax(input.clientId, input);
  const lines = buildLines(input.items, tax.seller.defaultSac);
  const totals = documentTotals(lines, input.discountPaise, tax);
  await prisma.$transaction(async (tx) => {
    await tx.salesQuoteItem.deleteMany({ where: { quoteId: id } });
    await tx.salesQuote.update({
      where: { id },
      data: {
        clientId: input.clientId,
        title: input.title,
        campaignType: input.campaignType,
        validUntil: input.validUntil ? dayToDate(input.validUntil) : null,
        placeOfSupplyCode: tax.placeOfSupplyCode,
        taxMode: tax.taxMode,
        gstRateBp: tax.gstRateBp,
        ...totals,
        notes: input.notes ?? null,
        internalNotes: input.internalNotes ?? null,
        items: { create: lines },
      },
    });
    await logSalesEvent(tx, { entityType: "quote", entityId: id, actorId, action: "updated" });
  });
  return getQuote(id);
}

export async function transitionQuote(id: string, action: keyof typeof QUOTE_TRANSITIONS, actorId: string) {
  const rule = QUOTE_TRANSITIONS[action];
  if (!rule) throw new AppError(400, "BAD_ACTION", "Unknown quote action");
  const q = await prisma.salesQuote.findUnique({ where: { id }, select: { status: true, validUntil: true } });
  if (!q) throw new AppError(404, "NOT_FOUND", "Quote not found");
  const effective = quoteExpired(q, todayIST()) ? "expired" : q.status;
  if (!rule.from.includes(effective)) throw new AppError(409, "BAD_TRANSITION", `A ${effective} quote cannot be ${action === "reopen" ? "reopened" : `${action}ed`}`);
  await prisma.$transaction(async (tx) => {
    await tx.salesQuote.update({
      where: { id },
      data: { status: rule.to, ...(rule.stamp ? { [rule.stamp]: new Date() } : {}), ...(action === "reopen" ? { validUntil: null } : {}) },
    });
    await logSalesEvent(tx, { entityType: "quote", entityId: id, actorId, action, fromStatus: effective, toStatus: rule.to });
  });
  return getQuote(id);
}

export async function deleteQuote(id: string): Promise<void> {
  const q = await prisma.salesQuote.findUnique({ where: { id }, select: { status: true } });
  if (!q) throw new AppError(404, "NOT_FOUND", "Quote not found");
  if (q.status !== "draft") throw new AppError(409, "QUOTE_LOCKED", "Only a draft quote can be deleted");
  await prisma.salesQuote.delete({ where: { id } });
}

/** An agreed quote becomes an order: same lines, same totals, the quote is marked converted. */
export async function convertQuote(id: string, actorId: string) {
  const q = await prisma.salesQuote.findUnique({ where: { id }, include: { items: { orderBy: { position: "asc" } } } });
  if (!q) throw new AppError(404, "NOT_FOUND", "Quote not found");
  if (q.status === "converted" && q.convertedOrderId) return getOrder(q.convertedOrderId);
  if (!["draft", "sent", "accepted"].includes(q.status)) throw new AppError(409, "BAD_TRANSITION", `A ${q.status} quote cannot be converted`);
  const seller = await getSellerOrDefaults();
  const orderId = await prisma.$transaction(async (tx) => {
    const number = await nextDocumentNumber(tx, "order", seller.orderPrefix, todayIST());
    const order = await tx.salesOrder.create({
      data: {
        number,
        clientId: q.clientId,
        quoteId: q.id,
        title: q.title,
        status: "confirmed",
        confirmedAt: new Date(),
        campaignType: q.campaignType,
        placeOfSupplyCode: q.placeOfSupplyCode,
        taxMode: q.taxMode,
        gstRateBp: q.gstRateBp,
        subtotalPaise: q.subtotalPaise,
        discountPaise: q.discountPaise,
        taxablePaise: q.taxablePaise,
        cgstPaise: q.cgstPaise,
        sgstPaise: q.sgstPaise,
        igstPaise: q.igstPaise,
        totalPaise: q.totalPaise,
        notes: q.notes,
        internalNotes: q.internalNotes,
        createdById: actorId,
        items: {
          create: q.items.map((it) => ({
            position: it.position, kind: it.kind, targetType: it.targetType, targetId: it.targetId, platform: it.platform, format: it.format,
            description: it.description, accountName: it.accountName, accountHandle: it.accountHandle, quantity: it.quantity,
            unitPricePaise: it.unitPricePaise, discountPaise: it.discountPaise, amountPaise: it.amountPaise, sac: it.sac,
            scheduledOn: it.scheduledOn, rateCardId: it.rateCardId,
          })),
        },
      },
      select: { id: true },
    });
    await tx.salesQuote.update({ where: { id }, data: { status: "converted", convertedOrderId: order.id, acceptedAt: q.acceptedAt ?? new Date() } });
    await logSalesEvent(tx, { entityType: "quote", entityId: id, actorId, action: "converted", fromStatus: q.status, toStatus: "converted", note: number });
    await logSalesEvent(tx, { entityType: "order", entityId: order.id, actorId, action: "created_from_quote", toStatus: "confirmed", note: q.number });
    return order.id;
  });
  return getOrder(orderId);
}

// ── Orders ──────────────────────────────────────────────────────────────────────

const ORDER_TRANSITIONS: Record<string, { from: string[]; to: string; stamp?: "confirmedAt" | "deliveredAt" | "closedAt" | "cancelledAt" }> = {
  confirm: { from: ["draft"], to: "confirmed", stamp: "confirmedAt" },
  start: { from: ["confirmed"], to: "in_progress" },
  deliver: { from: ["confirmed", "in_progress"], to: "delivered", stamp: "deliveredAt" },
  close: { from: ["delivered"], to: "closed", stamp: "closedAt" },
  cancel: { from: ["draft", "confirmed", "in_progress"], to: "cancelled", stamp: "cancelledAt" },
};

export async function listOrders(filter: { status?: string; clientId?: string; q?: string }) {
  const term = filter.q?.trim();
  const rows = await prisma.salesOrder.findMany({
    where: {
      ...(filter.clientId ? { clientId: filter.clientId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(term ? { OR: [{ number: { contains: term, mode: "insensitive" } }, { title: { contains: term, mode: "insensitive" } }, { client: { companyName: { contains: term, mode: "insensitive" } } }] } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 500,
    include: {
      client: clientBrief,
      _count: { select: { items: true } },
      items: { select: { status: true } },
      invoices: { select: { id: true, number: true, status: true, totalPaise: true } },
    },
  });
  return rows.map((o) => ({
    ...o,
    startDate: dateToDay(o.startDate),
    endDate: dateToDay(o.endDate),
    itemCount: o._count.items,
    deliveredCount: o.items.filter((i) => i.status === "delivered").length,
    items: undefined,
  }));
}

export async function getOrder(id: string) {
  const o = await prisma.salesOrder.findUnique({
    where: { id },
    include: {
      client: clientBrief,
      items: { orderBy: { position: "asc" } },
      invoices: { select: { id: true, number: true, kind: true, status: true, totalPaise: true, paidPaise: true, tdsPaise: true, creditedPaise: true, issueDate: true, dueDate: true } },
    },
  });
  if (!o) throw new AppError(404, "NOT_FOUND", "Order not found");
  return {
    ...o,
    startDate: dateToDay(o.startDate),
    endDate: dateToDay(o.endDate),
    items: o.items.map((i) => ({ ...shapeItem(i), deliveredOn: dateToDay(i.deliveredOn) })),
    invoices: o.invoices.map((i) => ({ ...i, issueDate: dateToDay(i.issueDate), dueDate: dateToDay(i.dueDate) })),
  };
}

function orderData(input: OrderUpsertInput, tax: ResolvedTax, totals: ReturnType<typeof documentTotals>) {
  return {
    clientId: input.clientId,
    campaignBookingId: input.campaignBookingId ?? null,
    title: input.title,
    campaignType: input.campaignType,
    poNumber: input.poNumber ?? null,
    startDate: input.startDate ? dayToDate(input.startDate) : null,
    endDate: input.endDate ? dayToDate(input.endDate) : null,
    placeOfSupplyCode: tax.placeOfSupplyCode,
    taxMode: tax.taxMode,
    gstRateBp: tax.gstRateBp,
    ...totals,
    notes: input.notes ?? null,
    internalNotes: input.internalNotes ?? null,
  };
}

export async function createOrder(input: OrderUpsertInput, actorId: string) {
  const tax = await resolveDocumentTax(input.clientId, input);
  const lines = buildLines(input.items, tax.seller.defaultSac);
  const totals = documentTotals(lines, input.discountPaise, tax);
  const created = await prisma.$transaction(async (tx) => {
    const number = await nextDocumentNumber(tx, "order", tax.seller.orderPrefix, todayIST());
    const o = await tx.salesOrder.create({ data: { number, ...orderData(input, tax, totals), createdById: actorId, items: { create: lines } }, select: { id: true } });
    await logSalesEvent(tx, { entityType: "order", entityId: o.id, actorId, action: "created", toStatus: "draft" });
    return o;
  });
  return getOrder(created.id);
}

export async function updateOrder(id: string, input: OrderUpsertInput, actorId: string) {
  const existing = await prisma.salesOrder.findUnique({ where: { id }, select: { status: true } });
  if (!existing) throw new AppError(404, "NOT_FOUND", "Order not found");
  if (existing.status !== "draft" && existing.status !== "confirmed") throw new AppError(409, "ORDER_LOCKED", `A ${existing.status} order cannot be edited`);
  const tax = await resolveDocumentTax(input.clientId, input);
  const lines = buildLines(input.items, tax.seller.defaultSac);
  const totals = documentTotals(lines, input.discountPaise, tax);
  await prisma.$transaction(async (tx) => {
    // Saving an order recreates its lines with new ids, which would hide them from the "already
    // billed" check and let the same work be invoiced again. So once any invoice (a draft
    // included) covers the order, its lines are frozen: delete the draft or cancel the invoice first.
    await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${id} FOR UPDATE`;
    const billed = await tx.salesInvoice.findFirst({ where: { orderId: id, status: { not: "cancelled" } }, select: { number: true } });
    if (billed) throw new AppError(409, "ORDER_INVOICED", `This order is on ${billed.number ?? "a draft invoice"} — delete the draft or cancel the invoice before changing the order`);
    await tx.salesOrderItem.deleteMany({ where: { orderId: id } });
    await tx.salesOrder.update({ where: { id }, data: { ...orderData(input, tax, totals), items: { create: lines } } });
    await logSalesEvent(tx, { entityType: "order", entityId: id, actorId, action: "updated" });
  });
  return getOrder(id);
}

export async function transitionOrder(id: string, action: keyof typeof ORDER_TRANSITIONS, actorId: string, note?: string) {
  const rule = ORDER_TRANSITIONS[action];
  if (!rule) throw new AppError(400, "BAD_ACTION", "Unknown order action");
  const o = await prisma.salesOrder.findUnique({ where: { id }, select: { status: true } });
  if (!o) throw new AppError(404, "NOT_FOUND", "Order not found");
  if (!rule.from.includes(o.status)) throw new AppError(409, "BAD_TRANSITION", `A ${o.status} order cannot be ${action === "cancel" ? "cancelled" : `${action}ed`}`);
  await prisma.$transaction(async (tx) => {
    await tx.salesOrder.update({ where: { id }, data: { status: rule.to, ...(rule.stamp ? { [rule.stamp]: new Date() } : {}) } });
    await logSalesEvent(tx, { entityType: "order", entityId: id, actorId, action, fromStatus: o.status, toStatus: rule.to, note: note ?? null });
  });
  return getOrder(id);
}

export async function updateOrderItem(
  orderId: string,
  itemId: string,
  input: { status: string; permalink?: string | null; deliveredOn?: string | null },
  actorId: string,
) {
  const item = await prisma.salesOrderItem.findFirst({ where: { id: itemId, orderId }, select: { id: true, status: true, order: { select: { status: true } } } });
  if (!item) throw new AppError(404, "NOT_FOUND", "Order line not found");
  if (["closed", "cancelled"].includes(item.order.status)) throw new AppError(409, "ORDER_LOCKED", `A ${item.order.status} order's lines cannot change`);
  await prisma.$transaction(async (tx) => {
    await tx.salesOrderItem.update({
      where: { id: itemId },
      data: {
        status: input.status,
        permalink: input.permalink ?? null,
        deliveredOn: input.status === "delivered" ? dayToDate(input.deliveredOn ?? todayIST()) : null,
      },
    });
    // The first delivered line moves a confirmed order into progress; when every line has
    // settled the order is delivered.
    const lines = await tx.salesOrderItem.findMany({ where: { orderId }, select: { status: true } });
    const settled = lines.every((l) => l.status === "delivered" || l.status === "cancelled");
    const anyDelivered = lines.some((l) => l.status === "delivered");
    if (settled && anyDelivered && item.order.status !== "delivered") {
      await tx.salesOrder.update({ where: { id: orderId }, data: { status: "delivered", deliveredAt: new Date() } });
      await logSalesEvent(tx, { entityType: "order", entityId: orderId, actorId, action: "deliver", fromStatus: item.order.status, toStatus: "delivered", note: "every line delivered" });
    } else if (anyDelivered && item.order.status === "confirmed") {
      await tx.salesOrder.update({ where: { id: orderId }, data: { status: "in_progress" } });
    }
    await logSalesEvent(tx, { entityType: "order", entityId: orderId, actorId, action: "line_" + input.status, fromStatus: item.status, toStatus: input.status, note: input.permalink ?? null });
  });
  return getOrder(orderId);
}
