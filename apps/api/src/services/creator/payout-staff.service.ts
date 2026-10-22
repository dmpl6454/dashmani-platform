/**
 * Staff side of the creator payouts: the QUEUE (what needs a person, by filter), one payout's detail and history, the CSV
 * of the queue, the six actions on a payout, and the runtime switch that pauses every release.
 *
 * ⚠️ WHAT THIS FILE NEVER DOES
 *   • It never decides a money move itself. Every action is one engine step (payout.service) run as the staff member, and the
 *     engine's own gates apply to staff exactly as to the worker: "release now" is the SAME release gate (it refuses a payout
 *     whose hold has not run out, whose post is not verified, whose account is not activated, with a dispute open …), "mark paid"
 *     refuses while a transfer could still release, "retry" is refused once any refund exists on the payment [R4].
 *   • It never shows or stores bank data. Every row and every history line is built from an explicit allow-list: ids, names, amounts
 *     in paise, statuses, timestamps, the destination HINT ("HDFC ••••1234": a masked reference), and our own scrubbed notes.
 *     No PAN, account number, IFSC, Razorpay body or error payload ever reaches a response, a CSV cell or a log line here.
 *   • Every action is IDEMPOTENT and says 409 when the move is not legal: pausing a paused payout, resuming one that is not paused,
 *     reversing a reversed one and recording a payment twice are all a plain "already done"; the rest are refused with the reason.
 *   Every change to a payout writes its own creator_payout_events row (actor "staff" + the staff id), which is the audit trail. The ONE
 *   thing that belongs to no payout, the runtime release switch, writes an audit_logs row instead (who, when, from, to): the events
 *   table cannot hold it, because every event names the payout it is about.
 */
import { prisma, Prisma } from "@dashmani/db";
import { LIVE_ITEM_STATUSES } from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { csvCell } from "../report-links-csv.service";
import { createAuditLog } from "../audit.service";
import { razorpayConfig } from "../campaign/config";
import { creatorConfig } from "./creator-config";
import { onCreatorLinkVerified } from "./payout-ledger";
import { RELEASE_SWITCH_KEY, executePlannedPayout, markManualPaid, pausePayout, releasePayout, releaseSwitchOn, requireManualPayment, resumePayout, retryFailedPayout, reversePayout, type PayoutActor, type StepResult } from "./payout.service";

// ── Filters ─────────────────────────────────────────────────────────────────────

/**
 * The queue's views. `open` is everything that is not finished (settled, paid by hand, void, reversed). The others are the work lists:
 *   needs_attention       parked: Razorpay's facts and ours disagree, or a result stayed unknown
 *   manual_required       Route cannot pay this creator: pay by bank transfer and record the reference
 *   paused                a dispute, an outside refund, a bank change, a suspended creator or a staff pause is holding it
 *   held_awaiting_verify  the creator's share is set aside and no release is scheduled (the post is not verified yet; a row whose
 *                         `linkVerifiedAt` is set was verified and is waiting for the worker to schedule it, which it does within minutes)
 *   releasing             a release is scheduled (verified) or in flight
 *   settlement_pending    released; Razorpay has not settled it to the creator's bank yet
 *   failed                Razorpay refused the transfer, or the bank rejected the settlement
 *   owed_after_reversal   ⚠️ REVERSED, and the post is still live: the creator did the work and their share was taken back (a suspended
 *                         account, a reversal staff made), so they are owed money nobody tracks until someone pays it: "Pay by bank
 *                         transfer instead", then record the reference. A reversal of a post that was withdrawn or refunded is NOT here.
 *   finished              settled, paid by hand, void or reversed: newest first, so "was creator X paid, and what is the reference?"
 *                         has an answer in the portal
 *   all                   everything, finished or not, newest first (the campaign page asks for it with its campaign)
 */
export const PAYOUT_FILTERS = ["open", "needs_attention", "manual_required", "paused", "held_awaiting_verify", "releasing", "settlement_pending", "failed", "owed_after_reversal", "finished", "all"] as const;
export type PayoutFilter = (typeof PAYOUT_FILTERS)[number];

const TERMINAL = ["settled", "paid_manual", "void", "reversed"];

export const isPayoutFilter = (v: unknown): v is PayoutFilter => typeof v === "string" && (PAYOUT_FILTERS as readonly string[]).includes(v);

/** The views that read as a history: newest first. Every other view is a work list: oldest first, so the longest wait is on top. */
const NEWEST_FIRST: readonly PayoutFilter[] = ["finished", "all"];
const orderFor = (f: PayoutFilter): Prisma.CreatorPayoutOrderByWithRelationInput[] =>
  NEWEST_FIRST.includes(f) ? [{ createdAt: "desc" }, { id: "desc" }] : [{ createdAt: "asc" }, { id: "asc" }];

/**
 * The reversed payouts whose post is still live (the `owed_after_reversal` view). The tables carry no relations, so the item's status
 * is joined in SQL and the ids are handed to the Prisma filter. Bounded: reversed payouts of live posts are the exception.
 */
export async function owedAfterReversalIds(): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT p.id FROM creator_payouts p
      JOIN campaign_booking_items i ON i.id = p.booking_item_id
     WHERE p.status = 'reversed' AND i.status = ANY(${[...LIVE_ITEM_STATUSES]})
     ORDER BY p.created_at ASC, p.id ASC
     LIMIT 1000`;
  return rows.map((r) => r.id);
}

export function whereForFilter(f: PayoutFilter, ctx: { owedIds?: readonly string[] } = {}): Prisma.CreatorPayoutWhereInput {
  switch (f) {
    case "needs_attention":
      return { status: "needs_attention" };
    case "manual_required":
      return { status: "manual_required" };
    case "paused":
      return { pausedAt: { not: null }, status: { notIn: TERMINAL } };
    case "held_awaiting_verify":
      return { status: "held", releaseAfter: null };
    case "releasing":
      return { OR: [{ status: "release_requested" }, { status: "held", releaseAfter: { not: null } }] };
    case "settlement_pending":
      return { status: "released" };
    case "failed":
      return { status: { in: ["failed", "settlement_failed"] } };
    case "owed_after_reversal":
      return { status: "reversed", id: { in: [...(ctx.owedIds ?? [])] } };
    case "finished":
      return { status: { in: TERMINAL } };
    case "all":
      return {};
    default:
      return { status: { notIn: TERMINAL } };
  }
}

/** How many payouts each view holds (the tab badges). */
export async function countsByFilter(owedIds?: readonly string[]): Promise<Record<PayoutFilter, number>> {
  const owed = owedIds ?? (await owedAfterReversalIds());
  const entries = await Promise.all(PAYOUT_FILTERS.map(async (f) => [f, await prisma.creatorPayout.count({ where: whereForFilter(f, { owedIds: owed }) })] as const));
  return Object.fromEntries(entries) as Record<PayoutFilter, number>;
}

// ── Rows (an explicit allow-list) ───────────────────────────────────────────────

const ROW_SELECT = {
  id: true,
  bookingId: true,
  bookingItemId: true,
  creatorId: true,
  status: true,
  pausedAt: true,
  pausedReason: true,
  itemPricePaise: true,
  grossPaise: true,
  tdsPaise: true,
  amountPaise: true,
  amountReversedPaise: true,
  destinationHint: true,
  releaseAfter: true,
  heldAt: true,
  releasedAt: true,
  settledAt: true,
  reversedAt: true,
  errorCode: true,
  attempts: true,
  // The references that answer "was the creator paid?" for a finished payout: Razorpay's settlement UTR, or the reference staff recorded for a bank
  // transfer. Both are bank transaction references, never an account detail (a reference shaped like a PAN or an IFSC is refused when it is recorded).
  settlementUtr: true,
  manualReference: true,
  manualPaidAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CreatorPayoutSelect;
type RowRecord = Prisma.CreatorPayoutGetPayload<{ select: typeof ROW_SELECT }>;

export interface PayoutRow {
  id: string;
  bookingId: string;
  bookingName: string | null;
  bookingItemId: string;
  creatorId: string;
  creatorName: string | null;
  pageName: string | null;
  platform: string | null;
  format: string | null;
  status: string;
  pausedAt: Date | null;
  pausedReason: string | null;
  itemPricePaise: number;
  grossPaise: number;
  tdsPaise: number;
  amountPaise: number;
  amountReversedPaise: number;
  destinationHint: string | null;
  releaseAfter: Date | null;
  heldAt: Date | null;
  releasedAt: Date | null;
  settledAt: Date | null;
  reversedAt: Date | null;
  errorCode: string | null;
  attempts: number;
  settlementUtr: string | null;
  manualReference: string | null;
  manualPaidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** The post's own status (live, refund_due, refunded …): a reversed payout of a LIVE post is money the creator is owed. */
  itemStatus: string | null;
  /** When staff verified the creator's link. Set on a `held` row with no `releaseAfter` = verified, release not scheduled yet (the worker does it). */
  linkVerifiedAt: Date | null;
  lastEvent: { kind: string; toStatus: string | null; note: string | null; at: Date } | null;
}

/** The names, the page and the latest history line for a page of payouts, in four small queries (the tables carry no relations). */
async function decorate(rows: RowRecord[]): Promise<PayoutRow[]> {
  if (rows.length === 0) return [];
  const [creators, items, bookings, events, offers] = await Promise.all([
    prisma.creator.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.creatorId))] } }, select: { id: true, name: true } }),
    prisma.campaignBookingItem.findMany({ where: { id: { in: rows.map((r) => r.bookingItemId) } }, select: { id: true, accountName: true, platform: true, format: true, status: true } }),
    prisma.campaignBooking.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.bookingId))] } }, select: { id: true, name: true } }),
    prisma.creatorPayoutEvent.findMany({
      where: { payoutId: { in: rows.map((r) => r.id) } },
      orderBy: [{ payoutId: "asc" }, { createdAt: "desc" }],
      distinct: ["payoutId"],
      select: { payoutId: true, kind: true, toStatus: true, note: true, createdAt: true },
    }),
    prisma.creatorOffer.findMany({ where: { bookingItemId: { in: rows.map((r) => r.bookingItemId) } }, select: { bookingItemId: true, linkVerifiedAt: true } }),
  ]);
  const verified = new Map(offers.map((o) => [o.bookingItemId, o.linkVerifiedAt]));
  const creator = new Map(creators.map((c) => [c.id, c.name]));
  const item = new Map(items.map((i) => [i.id, i]));
  const booking = new Map(bookings.map((b) => [b.id, b.name]));
  const event = new Map(events.map((e) => [e.payoutId, e]));
  return rows.map((r) => {
    const it = item.get(r.bookingItemId);
    const ev = event.get(r.id);
    return {
      ...r,
      bookingName: booking.get(r.bookingId) ?? null,
      creatorName: creator.get(r.creatorId) ?? null,
      pageName: it?.accountName ?? null,
      platform: it?.platform ?? null,
      format: it?.format ?? null,
      itemStatus: it?.status ?? null,
      linkVerifiedAt: verified.get(r.bookingItemId) ?? null,
      lastEvent: ev ? { kind: ev.kind, toStatus: ev.toStatus, note: ev.note, at: ev.createdAt } : null,
    };
  });
}

const LIMIT_MAX = 200;

/** The queue: one view (oldest first; the history views newest first), with keyset paging (`cursor` = the last id of the previous page) and every view's count. */
export async function listPayoutQueue(o: { filter?: PayoutFilter; limit?: number; cursor?: string | null; bookingId?: string | null; creatorId?: string | null } = {}) {
  const filter = o.filter ?? "open";
  const take = Math.max(1, Math.min(Math.floor(o.limit ?? 50) || 50, LIMIT_MAX));
  const owedIds = await owedAfterReversalIds();
  const where: Prisma.CreatorPayoutWhereInput = { AND: [whereForFilter(filter, { owedIds }), ...(o.bookingId ? [{ bookingId: o.bookingId }] : []), ...(o.creatorId ? [{ creatorId: o.creatorId }] : [])] };
  const rows = await prisma.creatorPayout.findMany({
    where,
    orderBy: orderFor(filter),
    take: take + 1,
    ...(o.cursor ? { skip: 1, cursor: { id: o.cursor } } : {}),
    select: ROW_SELECT,
  });
  const page = rows.slice(0, take);
  const [shaped, counts, releaseOn] = await Promise.all([decorate(page), countsByFilter(owedIds), releaseSwitchOn()]);
  return {
    filter,
    rows: shaped,
    nextCursor: rows.length > take ? page[page.length - 1].id : null,
    counts,
    // What staff must know before acting: whether anything is being released at all, whether new transfers are being made, and whether Razorpay's keys
    // are set (without them the worker is idle and every transfer, release and reversal is refused, whatever the other switches say).
    switches: { release: releaseOn, newTransfers: creatorConfig.routeEnabled(), worker: creatorConfig.payoutCronEnabled(), razorpay: razorpayConfig.configured() },
  };
}

// ── One payout ──────────────────────────────────────────────────────────────────

export async function getPayoutDetail(id: string) {
  const p = await prisma.creatorPayout.findUnique({
    where: { id },
    select: {
      ...ROW_SELECT,
      razorpayPaymentId: true,
      razorpayAccountId: true,
      razorpayTransferId: true,
      transferStatus: true,
      settlementStatus: true,
      recipientSettlementStatus: true,
      recipientSettlementId: true,
      settlementUtr: true,
      shareBps: true,
      tdsBps: true,
      nextAttemptAt: true,
      lastCheckedAt: true,
      onHoldVerifiedAt: true,
      transferRequestedAt: true,
      releaseRequestedAt: true,
      reversalRequestedAt: true,
      voidReason: true,
      lastError: true,
      manualReference: true,
      manualPaidAt: true,
      manualNote: true,
    },
  });
  if (!p) throw new AppError(404, "NOT_FOUND", "Payout not found");
  const [decorated, events, item, offer, disputes, account] = await Promise.all([
    decorate([p]),
    prisma.creatorPayoutEvent.findMany({ where: { payoutId: id }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true, kind: true, fromStatus: true, toStatus: true, amountPaise: true, actorType: true, note: true, createdAt: true } }),
    prisma.campaignBookingItem.findUnique({ where: { id: p.bookingItemId }, select: { status: true, accountName: true, platform: true, format: true, permalink: true } }),
    prisma.creatorOffer.findUnique({ where: { bookingItemId: p.bookingItemId }, select: { status: true, closedReason: true, linkSubmittedAt: true, linkVerifiedAt: true, ownershipCheck: true, expiresAt: true } }),
    prisma.campaignDispute.findMany({ where: { razorpayPaymentId: p.razorpayPaymentId }, select: { razorpayDisputeId: true, status: true, amountPaise: true, openedAt: true, closedAt: true } }),
    prisma.creatorPayoutAccount.findFirst({ where: { creatorId: p.creatorId }, select: { activationStatus: true, bankChangeRequestedAt: true, bankChangeClearedAt: true } }),
  ]);
  return {
    // `p` is the allow-listed select above (the Razorpay ids are references, not bank details: the linked account's acc_… id is what staff
    // look up in the dashboard); `decorated[0]` adds the names and the latest history line.
    payout: { ...p, ...decorated[0] },
    events,
    item,
    offer,
    disputes,
    account: account ? { activationStatus: account.activationStatus, bankChangePending: account.bankChangeRequestedAt !== null && (account.bankChangeClearedAt === null || account.bankChangeClearedAt < account.bankChangeRequestedAt) } : null,
  };
}

// ── The CSV ─────────────────────────────────────────────────────────────────────

const CSV_BATCH = 500;
export const PAYOUT_CSV_HEADERS = [
  "Payout",
  "Campaign",
  "Campaign name",
  "Post",
  "Creator",
  "Page",
  "Status",
  "Paused",
  "Paused reason",
  "Item price (INR)",
  "Share before tax (INR)",
  "Tax withheld (INR)",
  "Creator amount (INR)",
  "Reversed (INR)",
  "Destination",
  "Held at (UTC)",
  "Release after (UTC)",
  "Released at (UTC)",
  "Settled at (UTC)",
  "Reversed at (UTC)",
  "Created (UTC)",
  "Error code",
  "Last event",
  // Appended, never inserted: a sheet someone already built keeps its columns.
  "Post status",
  "Verified at (UTC)",
  "Paid: settlement UTR",
  "Paid: bank transfer reference",
  "Bank transfer recorded at (UTC)",
] as const;

const inr = (paise: number) => (paise / 100).toFixed(2);
const iso = (d: Date | null) => (d ? d.toISOString() : "");

export function payoutCsvLine(r: PayoutRow): string {
  return (
    [
      r.id,
      r.bookingId,
      r.bookingName,
      r.bookingItemId,
      r.creatorName,
      r.pageName,
      r.status,
      r.pausedAt ? "yes" : "no",
      r.pausedReason,
      inr(r.itemPricePaise),
      inr(r.grossPaise),
      inr(r.tdsPaise),
      inr(r.amountPaise),
      inr(r.amountReversedPaise),
      r.destinationHint,
      iso(r.heldAt),
      iso(r.releaseAfter),
      iso(r.releasedAt),
      iso(r.settledAt),
      iso(r.reversedAt),
      iso(r.createdAt),
      r.errorCode,
      r.lastEvent ? `${r.lastEvent.kind}${r.lastEvent.toStatus ? ` -> ${r.lastEvent.toStatus}` : ""}` : "",
      r.itemStatus,
      iso(r.linkVerifiedAt),
      r.settlementUtr,
      r.manualReference,
      iso(r.manualPaidAt),
    ]
      // Every cell is formula-guarded: a creator's name and a page's name are text somebody else chose.
      .map(csvCell)
      .join(",") + "\r\n"
  );
}

/**
 * The queue as a streamed CSV, keyset-paginated in batches of CSV_BATCH (O(batch) memory, whatever the size). Same filters (and the same
 * order) as the queue; returns the number of rows written.
 *
 * ⚠️ THE HEADER GOES OUT ONLY AFTER THE FIRST BATCH HAS BEEN READ **AND DECORATED**. The names, pages and history lines come from four
 * more queries, and the manual_required export is the bank-transfer worklist: a failure in any first-batch query must reach the route
 * with nothing sent (a clean 500), never a header-only 200 that reads "nobody is waiting". A failure AFTER bytes went out cannot change
 * the status line any more, so the route aborts the connection instead (see campaign-admin.routes.ts) and the file is never "complete".
 */
export async function streamPayoutsCsv(o: { filter?: PayoutFilter; bookingId?: string | null; creatorId?: string | null }, write: (chunk: string) => void): Promise<number> {
  const filter = o.filter ?? "open";
  const owedIds = filter === "owed_after_reversal" ? await owedAfterReversalIds() : undefined;
  const where: Prisma.CreatorPayoutWhereInput = { AND: [whereForFilter(filter, { owedIds }), ...(o.bookingId ? [{ bookingId: o.bookingId }] : []), ...(o.creatorId ? [{ creatorId: o.creatorId }] : [])] };
  let cursor: string | undefined;
  let count = 0;
  let headerWritten = false;
  for (;;) {
    const rows = await prisma.creatorPayout.findMany({
      where,
      orderBy: orderFor(filter),
      take: CSV_BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: ROW_SELECT,
    });
    const shaped = await decorate(rows);
    if (!headerWritten) {
      write("﻿" + PAYOUT_CSV_HEADERS.map(csvCell).join(",") + "\r\n");
      headerWritten = true;
    }
    if (rows.length === 0) break;
    let chunk = "";
    for (const r of shaped) chunk += payoutCsvLine(r);
    write(chunk);
    count += rows.length;
    cursor = rows[rows.length - 1].id;
    if (rows.length < CSV_BATCH) break;
  }
  return count;
}

export const payoutCsvFilename = (filter: PayoutFilter, now: Date = new Date()) => `creator-payouts-${filter.replace(/_/g, "-")}-${now.toISOString().slice(0, 10)}.csv`;

// ── The actions ─────────────────────────────────────────────────────────────────

const staffActor = (staffId: string): PayoutActor => ({ type: "staff", id: staffId });

/** Plain words for why an engine step said no. Codes not listed read as the generic line, with the code kept for the support trail. */
const WHY: Record<string, string> = {
  // generic outcomes
  not_applicable: "it is not in a state where that can be done",
  not_pausable: "it has already finished, so there is nothing to pause",
  not_failed: "only a failed transfer can be retried",
  not_planned: "its transfer has already been requested",
  not_manual_required: "only a payout marked as to-be-paid-by-bank-transfer can be recorded as paid",
  not_reversible: "it is not in a state where its transfer can be taken back",
  retry_disabled: "a refund already exists on the brand's payment, so Razorpay can no longer transfer from it: pay the creator by bank transfer instead",
  transfer_still_active: "a transfer for it is still alive at Razorpay (reverse it, or wait for it)",
  waiting: "it is waiting for something that has not happened yet",
  disabled: "new transfers are switched off, or Razorpay is not configured",
  unread: "Razorpay could not be read just now: nothing was changed, try again in a few minutes",
  unknown: "Razorpay did not give a readable answer: nothing was changed, it is being reconciled",
  leased: "another step is working on it right now: try again in a minute",
  lost_claim: "it changed while you were doing this: refresh and look again",
  invalid_reference: "the bank transfer reference is not valid (4 to 100 letters, digits or - _ . / : #; never a PAN or an IFSC)",
  needs_human: "it needs a person",
  // the release gate
  release_paused: "all releases are paused (the runtime switch is off)",
  payout_not_held: "it is not held (it may have been released, reversed or parked already)",
  payout_paused: "it is paused: resume it first",
  no_transfer: "it has no transfer",
  booking_not_releasable: "the campaign is not in a state where a post can be paid (rejected, cancelled or refunded)",
  item_not_live: "the post is not live",
  offer_missing: "there is no creator offer for this post",
  offer_not_completed: "the creator's offer is not completed (the post has not been verified)",
  link_not_verified: "the creator's link has not been verified",
  ownership_unchecked: "the check that the post is on the creator's page has not passed",
  dispute_recorded: "a dispute is recorded on the brand's payment",
  dispute_at_razorpay: "Razorpay lists a dispute on the brand's payment",
  dispute_unchecked: "Razorpay's disputes could not be read, so nothing is released",
  bank_change_pending: "the creator's bank change is pending or less than 72 hours old",
  release_not_scheduled: "no release has been scheduled yet. It is scheduled when the post is verified, and a post that was verified is scheduled by the worker within a few minutes (this button also tries it first): if this stays, check that the post is verified",
  release_not_due: "the release is scheduled for later (the hold has not run out)",
  transfer_unreadable: "the transfer could not be read at Razorpay",
  transfer_mismatch: "the transfer at Razorpay does not match this payout",
  transfer_not_processed: "Razorpay has not finished the transfer",
  transfer_not_on_hold: "the transfer is not on hold at Razorpay",
  transfer_hold_expires: "the transfer has an automatic release date at Razorpay",
  transfer_reversed: "the transfer has been (partly) reversed",
  duplicate_transfer: "a second transfer carries this payout's id",
  duplicate_unchecked: "Razorpay's transfers could not be listed, so nothing is released",
  account_not_activated: "the creator's payout account is not activated",
  account_unchecked: "the creator's payout account could not be read at Razorpay",
  creator_suspended: "the creator is suspended: nothing is paid to a suspended creator",
  creator_not_active: "the creator's account is not in good standing: nothing is paid until a person has looked at it",
  post_not_live: "the post is not live any more (it was withdrawn, declined or refunded), or the client has been refunded for it, so there is nothing to pay the creator for",
  reversal_failed_state: "its transfer could not be taken back in its current state: look at the payout in Razorpay",
  // refunds on the client's payment, and the proof that no transfer could still release money (the manual-payment and refund-ordering gates)
  refund_at_razorpay: "Razorpay lists a refund on the client's payment that this payout cannot account for, so nothing is released: look at the payment's refunds in the Razorpay dashboard",
  refund_unchecked: "Razorpay's refunds on the client's payment could not be read, so nothing is released: try again in a few minutes",
  transfer_exists: "a transfer for it may still release money at Razorpay (it has not failed or been taken back), so paying by hand could pay the creator twice",
  transfer_not_failed: "its transfer at Razorpay has not failed or been taken back, so it could still release money: paying by hand could pay the creator twice",
  transfer_active: "a transfer carrying this payout is still alive at Razorpay: take it back or wait for it, otherwise this could pay the creator twice",
  transfer_unchecked: "its transfer could not be read at Razorpay, so nobody can tell whether it could still release money: nothing was changed, try again in a few minutes",
  listing_unchecked: "Razorpay's list of this payment's transfers could not be read, so nobody can show that no transfer exists: nothing was changed, try again in a few minutes",
  not_reversed: "the transfer is fully reversed at Razorpay, but this payout has not recorded taking it back: it is being reconciled, try again in a few minutes",
  item_refunded: "the client has been (or is being) refunded for this post, so the creator is owed nothing for it",
  transfer_not_ours: "the transfer with that id at Razorpay is not this payout's (a different payout, account, payment or amount)",
  // resume
  dispute_open: "a dispute is still open on the brand's payment",
  not_paused: "it is not paused",
};

/** The words above, for the test that holds every reason the engine can give against them (a reason without a sentence reads as "not possible in its current state"). */
export const STAFF_REFUSAL_WORDS: Readonly<Record<string, string>> = WHY;

function why(r: StepResult): string {
  return WHY[r.reason ?? ""] ?? WHY[r.outcome] ?? "it is not possible in its current state";
}

/** An action that the engine refused: a 404 for no such payout, else a 409 saying why in plain words (and the code, for the support trail). */
function refusal(what: string, r: StepResult): never {
  if (r.outcome === "not_found") throw new AppError(404, "NOT_FOUND", "Payout not found");
  throw new AppError(409, "PAYOUT_ACTION_REFUSED", `Not done: ${what}. ${why(r).replace(/^./, (c) => c.toUpperCase())}. Nothing was changed. [${r.reason ?? r.outcome}]`);
}

async function done(id: string, r: StepResult, note?: string) {
  return { ...(await getPayoutDetail(id)), result: { ok: r.ok, outcome: r.outcome, ...(r.reason ? { reason: r.reason } : {}), ...(note ? { note } : {}) } };
}

export async function staffPause(id: string, staffId: string, reason?: string) {
  const r = await pausePayout(id, { actor: staffActor(staffId), reason: reason?.slice(0, 120) });
  if (!r.ok) refusal("pause this payout", r);
  return done(id, r);
}

export async function staffResume(id: string, staffId: string) {
  const r = await resumePayout(id, { actor: staffActor(staffId) });
  // Resuming a payout that is not paused is already what was asked for.
  if (!r.ok && !(r.outcome === "refused" && r.reason === "not_paused")) refusal("resume this payout", r);
  return done(id, r.ok ? r : { ...r, ok: true, outcome: "not_paused" });
}

/** A failed payout is retried (a fresh transfer, behind two empty listings); a planned one that never started is run now. */
export async function staffRetryTransfer(id: string, staffId: string) {
  const cur = await prisma.creatorPayout.findUnique({ where: { id }, select: { status: true } });
  if (!cur) throw new AppError(404, "NOT_FOUND", "Payout not found");
  if (cur.status === "failed") {
    const r = await retryFailedPayout(id, { actor: staffActor(staffId) });
    // An unknown answer is not a refusal: the payout is transfer_requested and the worker reads Razorpay.
    if (!r.ok && r.outcome !== "unknown" && r.status !== "transfer_requested" && r.status !== "held") refusal("retry the transfer", r);
    return done(id, r);
  }
  if (cur.status === "planned") {
    const r = await executePlannedPayout(id, { actor: staffActor(staffId) });
    if (!r.ok && r.outcome !== "unknown" && r.status === "planned") refusal("make the transfer", r);
    return done(id, r);
  }
  throw new AppError(409, "PAYOUT_ACTION_REFUSED", `Not done: retry the transfer. Only a failed or a planned payout can be retried (this one is ${cur.status}). Nothing was changed.`);
}

/**
 * Take the creator's share back out of their linked account (explicit amount, read fresh; never "all"). The engine lets a person do this
 * from `needs_attention` too, and for a released or settlement_failed payout (which Razorpay may only allow against the account's floating
 * balance). A reversal Razorpay has not confirmed is not an error: the payout stays reversal_requested and the worker reads it back.
 */
export async function staffReverse(id: string, staffId: string, reason?: string) {
  // A payout that has no transfer has nothing to take back (a result that stayed unknown and was parked, for one): asking the engine would
  // claim the row, fail to find a transfer, roll back, overwrite the real reason it was parked and send an alert. Refused up front, nothing touched.
  const cur = await prisma.creatorPayout.findUnique({ where: { id }, select: { status: true, razorpayTransferId: true } });
  if (cur && !cur.razorpayTransferId && ["needs_attention", "held", "released", "settlement_failed"].includes(cur.status)) {
    refusal("take this payout back", { ok: false, outcome: "refused", payoutId: id, status: cur.status, calls: 0, reason: "no_transfer" });
  }
  const r = await reversePayout(id, { actor: staffActor(staffId), reason: (reason?.trim() || "staff").slice(0, 40) });
  const pending = r.status === "reversal_requested" || r.outcome === "unknown" || r.outcome === "partial" || r.outcome === "waiting";
  if (!r.ok && !pending) refusal("take this payout back", r);
  return done(id, r, pending ? "The reversal has not been confirmed by Razorpay yet; it is being read back and finished automatically." : undefined);
}

/** Staff paid the creator by bank transfer and record its reference. Refused while a transfer could still release money. */
export async function staffMarkManualPaid(id: string, staffId: string, o: { reference: string; note?: string }) {
  const r = await markManualPaid(id, { actor: staffActor(staffId), reference: o.reference, note: o.note });
  if (!r.ok && r.status !== "paid_manual") refusal("record this payment", r);
  return done(id, r.ok ? r : { ...r, ok: true, outcome: "already_paid_manual" });
}

/** Mark a payout as one that must be paid by bank transfer (planned, failed, reversed or parked); recording the payment is a separate step. */
export async function staffRequireManual(id: string, staffId: string, reason: string) {
  // ⚠️ "Reverse first, then pay by hand" is for a post that is LIVE and was delivered. A payout taken back because the post was withdrawn,
  // declined or refunded must not be turned into "pay the creator by bank transfer": that would invite paying for a post the client was refunded for.
  const cur = await prisma.creatorPayout.findUnique({ where: { id }, select: { status: true, bookingItemId: true } });
  if (cur?.status === "reversed") {
    const [item, refunds] = await Promise.all([
      prisma.campaignBookingItem.findUnique({ where: { id: cur.bookingItemId }, select: { status: true } }),
      prisma.campaignRefund.count({ where: { bookingItemId: cur.bookingItemId, status: { not: "failed" } } }),
    ]);
    if (!item || !(LIVE_ITEM_STATUSES as readonly string[]).includes(item.status) || refunds > 0) {
      refusal("mark this payout as to be paid by bank transfer", { ok: false, outcome: "refused", payoutId: id, status: cur.status, calls: 0, reason: "post_not_live" });
    }
  }
  const r = await requireManualPayment(id, { actor: staffActor(staffId), reason: reason.slice(0, 80) });
  if (!r.ok) refusal("mark this payout as to be paid by bank transfer", r);
  return done(id, r);
}

/**
 * Release now: the SAME release gate as the worker (evaluateRelease over fresh facts), run on demand. It cannot bypass anything: a hold that
 * has not run out, an unverified post, a dispute, a pending bank change, a paused payout or the runtime switch each refuse it, with the reason.
 */
export async function staffReleaseNow(id: string, staffId: string) {
  // A post that was verified but whose release was never scheduled (the scheduling step failed after the verification committed) is scheduled
  // first, exactly as the worker's repair would: idempotent (only a payout with no release_after is touched), never throws, and the release gate
  // below still checks everything fresh, so this can only turn "no release is scheduled" into the real answer (due now, or "the hold runs until …").
  const cur = await prisma.creatorPayout.findUnique({ where: { id }, select: { bookingItemId: true, releaseAfter: true } });
  if (cur && cur.releaseAfter === null) await onCreatorLinkVerified(cur.bookingItemId, staffActor(staffId));
  const r = await releasePayout(id, { actor: staffActor(staffId) });
  const inFlight = r.status === "release_requested" || r.outcome === "unknown";
  if (!r.ok && !inFlight) refusal("release this payout", r);
  return done(id, r, inFlight ? "The release was requested and Razorpay has not confirmed it yet; it is being read back and finished automatically." : undefined);
}

// ── The runtime switch ──────────────────────────────────────────────────────────

/** The audit action of a change of the release switch (audit_logs.action). */
export const RELEASE_SWITCH_AUDIT_ACTION = "creator_payouts.release_switch";

/**
 * The switch as staff read it: absent = on, and who last changed it, when, and from what. `lastChange` comes from audit_logs (written by
 * setReleaseSwitch); it is null when nobody ever changed it through the portal. `updatedAt` is the setting's own time, so a change made by hand
 * on the server (the SQL below) still shows WHEN, even though nobody's name is on it.
 */
export async function getReleaseSwitch(): Promise<{
  key: string;
  release: "on" | "off";
  updatedAt: string | null;
  lastChange: { at: string; byId: string; byName: string | null; from: "on" | "off" | null; to: "on" | "off" | null } | null;
}> {
  const readMode = (v: unknown): "on" | "off" | null => {
    const r = (v as { release?: unknown } | null | undefined)?.release;
    return r === "on" || r === "off" ? r : null;
  };
  const [release, setting, last] = await Promise.all([
    releaseSwitchOn(),
    prisma.systemSetting.findUnique({ where: { key: RELEASE_SWITCH_KEY }, select: { updatedAt: true } }).catch(() => null),
    prisma.auditLog
      .findFirst({
        where: { action: RELEASE_SWITCH_AUDIT_ACTION, resourceId: RELEASE_SWITCH_KEY },
        orderBy: { createdAt: "desc" },
        select: { userId: true, before: true, after: true, createdAt: true, user: { select: { name: true } } },
      })
      .catch(() => null),
  ]);
  return {
    key: RELEASE_SWITCH_KEY,
    release: release ? "on" : "off",
    updatedAt: setting?.updatedAt ? setting.updatedAt.toISOString() : null,
    lastChange: last ? { at: last.createdAt.toISOString(), byId: last.userId, byName: last.user?.name ?? null, from: readMode(last.before), to: readMode(last.after) } : null,
  };
}

/**
 * Pause ('off') or resume ('on') EVERY release, with no restart: the engine reads system_settings creatorPayouts.release before each
 * release, so it takes effect on the next one. It stops only the money going OUT; transfers, holds, reversals and refunds carry on.
 * The same change by hand, on the server:
 *   INSERT INTO system_settings (key, value, updated_at) VALUES ('creatorPayouts.release', 'off', timezone('utc', now()))
 *     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;
 * (set 'on', or delete the row, to resume).
 *
 * ⚠️ WHO FLIPPED IT. The one flag that decides whether every creator's money goes out writes an audit_logs row (the staff member, the
 * time, the value before and after), like every payout action does in creator_payout_events. It is audit_logs and not that table because an
 * event row must name the payout it is about and this belongs to none. The audit is BEST EFFORT and comes AFTER the write: an emergency
 * "off" must never fail because the audit table is unwritable (the console line stays as the second record). A call that changes nothing
 * (a double click) writes no row.
 */
export async function setReleaseSwitch(mode: "on" | "off", staffId: string) {
  const before = (await releaseSwitchOn()) ? "on" : "off";
  await prisma.systemSetting.upsert({ where: { key: RELEASE_SWITCH_KEY }, create: { key: RELEASE_SWITCH_KEY, value: mode }, update: { value: mode } });
  console.warn(`[creator-payouts] releases switched ${mode} by staff ${staffId}`);
  if (before !== mode) {
    try {
      await createAuditLog({ userId: staffId, action: RELEASE_SWITCH_AUDIT_ACTION, resource: "system_settings", resourceId: RELEASE_SWITCH_KEY, before: { release: before }, after: { release: mode } });
    } catch (err) {
      console.error(`[creator-payouts] the release switch was changed but its audit row could not be written: ${(err as Error)?.name ?? "error"}`);
    }
  }
  return getReleaseSwitch();
}

// ── A compact summary on the campaign page ──────────────────────────────────────

/**
 * What the campaign page shows of ONE post's payout, whatever state it is in (finished payouts included: "Paid" with its UTR, "Taken back",
 * "Paid by hand" with its reference). An explicit allow-list like every shape here: ids, amounts in paise, statuses, timestamps and the two
 * bank-transaction REFERENCES; never a Razorpay id, a bank detail or a Razorpay body.
 */
export interface PayoutSummary {
  id: string;
  status: string;
  amountPaise: number;
  amountReversedPaise: number;
  pausedAt: Date | null;
  pausedReason: string | null;
  releaseAfter: Date | null;
  releasedAt: Date | null;
  settledAt: Date | null;
  reversedAt: Date | null;
  settlementUtr: string | null;
  manualReference: string | null;
  manualPaidAt: Date | null;
  errorCode: string | null;
}

const SUMMARY_SELECT = {
  id: true,
  bookingItemId: true,
  status: true,
  amountPaise: true,
  amountReversedPaise: true,
  pausedAt: true,
  pausedReason: true,
  releaseAfter: true,
  releasedAt: true,
  settledAt: true,
  reversedAt: true,
  settlementUtr: true,
  manualReference: true,
  manualPaidAt: true,
  errorCode: true,
} satisfies Prisma.CreatorPayoutSelect;

/** One booking's payouts by item id, in one query. */
export async function payoutSummariesForBooking(bookingId: string): Promise<Map<string, PayoutSummary>> {
  const rows = await prisma.creatorPayout.findMany({ where: { bookingId }, select: SUMMARY_SELECT });
  return new Map(
    rows.map((r) => {
      const { bookingItemId, ...summary } = r;
      return [bookingItemId, summary as PayoutSummary] as const;
    }),
  );
}
