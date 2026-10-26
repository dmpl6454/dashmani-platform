import { prisma } from "@dashmani/db";
import { BOOKING_STATUS_LABELS, LIVE_ITEM_STATUSES, type BookingStatus } from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { dateToDay } from "./common";

// Client campaign bookings (client.digitalsukoon.com → Campaigns, reviewed in the staff portal)
// as the sales team sees them: what was booked, where it stands, and whether it has been billed.
// Read-only here — review, posting and refunds stay in the staff portal. Bookings belong to no
// billing company; the invoice made from one belongs to the company chosen when it is created.

/** Never billable: nothing was bought, or the money went back. */
export const UNBILLABLE_BOOKING_STATUSES: readonly BookingStatus[] = ["draft", "awaiting_payment", "rejected", "refunded", "cancelled", "expired"];
/** Item statuses that are not billed: the post was never made (failed) or was refunded. */
export const UNBILLED_ITEM_STATUSES = ["failed", "refunded"] as const;

export const BOOKING_STAGES = {
  review: ["paid_pending_review", "changes_requested"],
  active: ["approved", "publishing"],
  live: ["completed", "partially_published"],
  awaiting_payment: ["awaiting_payment"],
  closed: ["rejected", "refunded", "cancelled", "expired"],
} as const satisfies Record<string, readonly BookingStatus[]>;
export type BookingStage = keyof typeof BOOKING_STAGES | "to_invoice" | "all";

const billable = (status: string) => !(UNBILLABLE_BOOKING_STATUSES as readonly string[]).includes(status);
const isLive = (s: string) => (LIVE_ITEM_STATUSES as readonly string[]).includes(s);
const isBilledItem = (s: string) => !(UNBILLED_ITEM_STATUSES as readonly string[]).includes(s);

const clientBrief = { select: { id: true, companyName: true, billingProfile: { select: { legalName: true } } } } as const;
const invoiceBrief = { id: true, number: true, kind: true, status: true, companyKey: true, totalPaise: true, campaignBookingId: true } as const;

async function invoicesFor(ids: string[]) {
  if (!ids.length) return new Map<string, Array<{ id: string; number: string | null; kind: string; status: string; companyKey: string; totalPaise: number }>>();
  const rows = await prisma.salesInvoice.findMany({ where: { campaignBookingId: { in: ids } }, orderBy: { createdAt: "asc" }, select: invoiceBrief });
  const map = new Map<string, typeof rows>();
  for (const r of rows) map.set(r.campaignBookingId!, [...(map.get(r.campaignBookingId!) ?? []), r]);
  return map;
}

export async function listBookings(filter: { stage?: string; q?: string; clientId?: string }) {
  const stage = (filter.stage ?? "all") as BookingStage;
  const term = filter.q?.trim();
  const statusIn: readonly string[] | undefined =
    stage in BOOKING_STAGES ? BOOKING_STAGES[stage as keyof typeof BOOKING_STAGES]
    : stage === "to_invoice" ? [...BOOKING_STAGES.review, ...BOOKING_STAGES.active, ...BOOKING_STAGES.live]
    : undefined;
  const rows = await prisma.campaignBooking.findMany({
    where: {
      // Drafts are a client's unfinished cart, not a sale.
      status: statusIn ? { in: [...statusIn] } : { not: "draft" },
      ...(filter.clientId ? { clientId: filter.clientId } : {}),
      ...(term ? { OR: [{ name: { contains: term, mode: "insensitive" } }, { brand: { contains: term, mode: "insensitive" } }, { client: { companyName: { contains: term, mode: "insensitive" } } }] } : {}),
    },
    orderBy: [{ submittedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    take: 300,
    select: {
      id: true, name: true, brand: true, status: true, format: true, campaignType: true, totalPaise: true,
      launchFrom: true, launchTo: true, submittedAt: true, paidAt: true, approvedAt: true, createdAt: true,
      client: clientBrief,
      items: { select: { status: true, pricePaise: true } },
    },
  });
  const invoices = await invoicesFor(rows.map((r) => r.id));
  const shaped = rows.map((r) => {
    const inv = invoices.get(r.id) ?? [];
    return {
      id: r.id, name: r.name, brand: r.brand, status: r.status, statusLabel: BOOKING_STATUS_LABELS[r.status as BookingStatus] ?? r.status,
      format: r.format, campaignType: r.campaignType, totalPaise: r.totalPaise,
      launchFrom: dateToDay(r.launchFrom), launchTo: dateToDay(r.launchTo),
      submittedAt: r.submittedAt, paidOnline: !!r.paidAt, approvedAt: r.approvedAt, createdAt: r.createdAt,
      client: r.client,
      itemCount: r.items.length,
      liveCount: r.items.filter((i) => isLive(i.status)).length,
      /** What an invoice made now would bill: every account except failed or refunded posts. */
      billablePaise: r.items.filter((i) => isBilledItem(i.status)).reduce((s, i) => s + i.pricePaise, 0),
      billable: billable(r.status),
      invoices: inv.map(({ id, number, kind, status, companyKey, totalPaise }) => ({ id, number, kind, status, companyKey, totalPaise })),
      /** On a live invoice (a draft or proforma counts: making another would bill it twice). */
      invoiced: inv.some((i) => i.status !== "cancelled"),
    };
  });
  return stage === "to_invoice" ? shaped.filter((b) => b.billable && !b.invoiced && b.billablePaise > 0) : shaped;
}

export type BookingRow = Awaited<ReturnType<typeof listBookings>>[number];

export async function getBooking(id: string) {
  const b = await prisma.campaignBooking.findUnique({
    where: { id },
    select: {
      id: true, name: true, brand: true, objective: true, status: true, format: true, campaignType: true, audioIntegration: true, audioTrack: true,
      totalPaise: true, launchFrom: true, launchTo: true, submittedAt: true, paidAt: true, approvedAt: true, deliveredAt: true, createdAt: true, reviewNote: true,
      client: { select: { id: true, companyName: true, contactName: true, email: true, billingProfile: { select: { legalName: true, gstin: true, stateCode: true } } } },
      items: {
        orderBy: [{ createdAt: "asc" }, { accountName: "asc" }, { id: "asc" }],
        select: { id: true, platform: true, format: true, accountName: true, accountHandle: true, pricePaise: true, audioAddonPaise: true, status: true, permalink: true, postedAt: true },
      },
    },
  });
  if (!b) throw new AppError(404, "NOT_FOUND", "Booking not found");
  const inv = (await invoicesFor([b.id])).get(b.id) ?? [];
  return {
    ...b,
    statusLabel: BOOKING_STATUS_LABELS[b.status as BookingStatus] ?? b.status,
    launchFrom: dateToDay(b.launchFrom), launchTo: dateToDay(b.launchTo),
    paidOnline: !!b.paidAt,
    billable: billable(b.status),
    billablePaise: b.items.filter((i) => isBilledItem(i.status)).reduce((s, i) => s + i.pricePaise, 0),
    items: b.items.map((i) => ({ ...i, live: isLive(i.status), billed: isBilledItem(i.status) })),
    invoices: inv.map(({ id, number, kind, status, companyKey, totalPaise }) => ({ id, number, kind, status, companyKey, totalPaise })),
  };
}

/** The dashboard's bookings block — company-independent (bookings belong to no billing company). */
export async function bookingsSummary() {
  const rows = await listBookings({ stage: "all" });
  const sum = (xs: BookingRow[], f: (b: BookingRow) => number) => xs.reduce((s, b) => s + f(b), 0);
  const inStage = (stage: keyof typeof BOOKING_STAGES) => rows.filter((b) => (BOOKING_STAGES[stage] as readonly string[]).includes(b.status));
  const toInvoice = rows.filter((b) => b.billable && !b.invoiced && b.billablePaise > 0);
  const review = inStage("review"), active = inStage("active"), live = inStage("live");
  return {
    review: { count: review.length, totalPaise: sum(review, (b) => b.totalPaise ?? 0) },
    active: { count: active.length, totalPaise: sum(active, (b) => b.totalPaise ?? 0) },
    live: { count: live.length, totalPaise: sum(live, (b) => b.totalPaise ?? 0) },
    toInvoice: { count: toInvoice.length, totalPaise: sum(toInvoice, (b) => b.billablePaise) },
    recentToInvoice: toInvoice.slice(0, 6).map((b) => ({ id: b.id, name: b.name, brand: b.brand, status: b.status, statusLabel: b.statusLabel, client: b.client.companyName, billablePaise: b.billablePaise })),
  };
}
