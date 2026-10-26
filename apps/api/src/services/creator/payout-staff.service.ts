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
// The staff pages' own words for a status and a pause reason, so a refusal names them exactly as the row behind the dialog does. Imported by
// module path: the module is pure (no React, no fetch).
import { pauseText, payoutStatusView } from "@dashmani/shared/src/payouts/staff-ui";
import { REVERSE_PAUSE_REASON } from "./payout-pause";
import { AppError } from "../../middleware/error-handler";
import { csvCell } from "../report-links-csv.service";
import { createAuditLog } from "../audit.service";
import { razorpayConfig } from "../campaign/config";
import { creatorConfig } from "./creator-config";
import { onCreatorLinkVerified } from "./payout-ledger";
import {
  RELEASE_SWITCH_KEY,
  adoptTransferByStaff,
  attestNoTransfer,
  confirmHold,
  executePlannedPayout,
  markManualPaid,
  pausePayout,
  priorStatusOfReversal,
  releasePayout,
  releaseSwitchOn,
  requireManualPayment,
  resumePayout,
  retryFailedPayout,
  reversePayout,
  scrubStaffText,
  type PayoutActor,
  type StepResult,
} from "./payout.service";

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
  // Read only to say WHETHER a transfer is recorded (`hasTransfer`): the id itself is dropped in decorate() and reaches only the detail.
  razorpayTransferId: true,
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
  /** Whether a Razorpay transfer is recorded on the payout (the id is only in the detail): decides "No other transfer" and "reverse it first". */
  hasTransfer: boolean;
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
  return rows.map(({ razorpayTransferId, ...r }) => {
    const it = item.get(r.bookingItemId);
    const ev = event.get(r.id);
    return {
      ...r,
      hasTransfer: razorpayTransferId !== null,
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

/**
 * A bank transaction reference as a CSV cell that a spreadsheet keeps as TEXT. A 12-digit IMPS or UPI reference written bare is read as a
 * number by Excel: shown as 4.23612E+11, and every digit past the 15th becomes a zero once the file is saved. A reference of digits and
 * separators only ("2026-10-18", "12/10") is turned into a date the same way. Those are written as the formula ="…", which a spreadsheet
 * shows as the plain text inside it. That is safe because what is inside can only be digits and the separators a reference may carry (no
 * quote, nothing a formula could use). Anything else (it has a letter, or it is not reference-shaped) is the ordinary formula-guarded cell.
 */
const NUMERIC_LOOKING_REFERENCE = /^[0-9][0-9 _./:#-]{0,99}$/;
export function referenceCsvCell(v: string | null): string {
  if (v && NUMERIC_LOOKING_REFERENCE.test(v)) return `"=""${v}"""`;
  return csvCell(v);
}

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
    ]
      // Every cell is formula-guarded: a creator's name and a page's name are text somebody else chose.
      .map(csvCell)
      // The two bank references stay text in a spreadsheet (referenceCsvCell); the time the hand payment was recorded is an ordinary cell.
      .concat([referenceCsvCell(r.settlementUtr), referenceCsvCell(r.manualReference), csvCell(iso(r.manualPaidAt))])
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
  retry_disabled: "a refund already exists on the brand's payment, so Razorpay can no longer transfer from it: if the post is live and verified, pay the creator by bank transfer instead; if it never went live, nothing is owed, so refund the post",
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
  post_not_live: "the creator's post is not live and verified (it never went live, or it was withdrawn, declined or refunded), or the client has been refunded for it, so there is nothing to pay the creator for (a post that is not going ahead is refunded from the campaign page)",
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
  // the two things a person can say after looking in the Razorpay dashboard (attest-no-transfer, adopt-transfer)
  transfer_not_found: "Razorpay has no transfer with that id (check it was copied whole, starting with trf_)",
  transfer_in_use: "that transfer is already recorded on another payout: look at both in the payout queue",
  transfer_from_earlier_request:
    "that transfer was made by an earlier request for this payout and has failed or been taken back, so it is not what the current request did (a Retry sends a new transfer, which is a different one): look in the Razorpay dashboard for a newer transfer carrying this payout's id and give that id, or wait for Razorpay's list of the payment's transfers, which is checked again every hour",
  attest_too_soon: "its last request to Razorpay was less than 10 minutes ago, and a request can still be on its way in: look in the dashboard again in a few minutes",
  transfer_recorded: "it already records a transfer at Razorpay, and only a payout whose request was sent twice and that is waiting on its check for a second transfer can be confirmed this way: take the recorded transfer back (Reverse), or wait for Razorpay's list of the payment's transfers",
  // resume
  dispute_open: "a dispute is still open on the brand's payment",
  not_paused: "it is not paused",
  // a reversal Razorpay refused (rollbackReversal), and one with nothing to take back
  reversal_refused: "Razorpay refused to take the transfer back, so the money is still on hold in the creator's linked account: look at the transfer in the Razorpay dashboard",
  // A Reverse refused on a payout that was NOT released ends here too (a parked payout whose transfer is still on hold): never "already released".
  reversal_refused_after_release:
    "Razorpay refused to take the transfer back (if it had been released, the money may already have settled to the creator's bank, or the linked account may no longer hold it): check the transfer and the linked account's balance in the Razorpay dashboard",
  nothing_to_reverse: "no transfer was ever made for it, so there is nothing to take back",
  // "Make transfer now" / "Retry transfer" waiting for something (decideTransferCreation), and Razorpay refusing the new transfer
  paused: "it is paused: resume it first",
  payment_not_captured: "the client's payment has not been captured yet",
  booking_closed: "the campaign is not in a state where a creator can be paid (rejected, cancelled or refunded)",
  item_closed: "the post is not going ahead (withdrawn, declined, refunded or failed), so nothing is transferred for it",
  account_not_ready: "the creator's payout account is not activated at Razorpay yet",
  amount_too_small: "the creator's share is below the smallest amount we transfer",
  failed: "Razorpay refused the new transfer (its answer is in the payout's history)",
};

/**
 * How a refusal ends when the payout still looks the same afterwards but the step wrote something anyway (an empty entry means the default:
 * "Nothing was changed."). A refusal whose payout visibly moved says that instead (changeSince).
 */
const ENDING: Record<string, string> = {
  // A person's Reverse pauses a held payout at its claim (reversePayout pauseIfRefused), so one put back in held is paused whoever finished it;
  // changeSince says so when the pause (or its reason) is new. This ending is for a payout that already carried the person's pause.
  reversal_refused: "No money moved; Razorpay's refusal is recorded in its history, and the payout stays held and paused, so it will not be released: press Reverse again to take it back, or resume it only if the creator should be paid after all.",
  failed: "No money was set aside; Razorpay's refusal is recorded in its history.",
};

/** The words above, for the test that holds every reason the engine can give against them (a reason without a sentence reads as "not possible in its current state"). */
export const STAFF_REFUSAL_WORDS: Readonly<Record<string, string>> = WHY;

function why(r: StepResult): string {
  return WHY[r.reason ?? ""] ?? WHY[r.outcome] ?? "it is not possible in its current state";
}

/**
 * What the staff UI sees of a payout around a refused step: whether it moved, whether it got paused, whether its release got scheduled, and the
 * problem a parked payout records (its error code: a refused step can re-park a parked payout under a new one, and alert staff about it).
 */
type Snapshot = { status: string; pausedAt: Date | null; pausedReason: string | null; releaseAfter: Date | null; errorCode?: string | null; releasedAt?: Date | null } | null;
// releasedAt: only priorStatusOfReversal's fallback reads it (pendingReverseNote); changeSince never does.
const SNAPSHOT_SELECT = { status: true, pausedAt: true, pausedReason: true, releaseAfter: true, errorCode: true, releasedAt: true } satisfies Prisma.CreatorPayoutSelect;

/** The refusals of a person's Reverse that put the payout back in held (rollbackReversal): it stays paused (the pause was put on at the claim). */
const REVERSAL_PUT_BACK_IN_HELD = ["reversal_refused", "transfer_not_processed"];
const snapshot = (id: string): Promise<Snapshot> => prisma.creatorPayout.findUnique({ where: { id }, select: SNAPSHOT_SELECT });

/**
 * What changed on a payout between two reads, in a sentence (null = nothing the staff UI shows). A refused step can still write before it
 * refuses (the release gate pauses the payment's payouts on a refund it cannot account for and parks a payout with a twin transfer; a reversal
 * Razorpay refuses parks it), and the worker can move a payout meanwhile: the person must never read "Nothing was changed" then. It says
 * what IS, not who did it.
 */
export function changeSince(before: Snapshot, after: Snapshot, reason?: string): string | null {
  if (!before || !after) return null;
  const parts: string[] = [];
  if (after.status !== before.status) parts.push(`its status is now ${after.status === "held" ? "Held" : payoutStatusView({ status: after.status, releaseAfter: null }).label}`);
  if (after.pausedAt && !before.pausedAt) {
    parts.push(
      reason === "refund_at_razorpay" && after.pausedReason === "external_refund"
        ? "it is now paused, with every other payout of the same client payment that was still in flight, until a person has looked at the payment's refunds"
        : REVERSAL_PUT_BACK_IN_HELD.includes(reason ?? "") && after.status === "held" && after.pausedReason === REVERSE_PAUSE_REASON
          ? "no money moved; it is held again and paused, so it will not be released. To take it back, press Reverse again once Razorpay allows it; resume it only if the creator should be paid after all (it is then released when due)"
          : `it is now paused (${pauseText(after.pausedReason)})`,
    );
  } else if (!after.pausedAt && before.pausedAt) parts.push("it is no longer paused");
  // A payout that was paused ALREADY (a dispute, a suspended creator, a staff pause) and that a person's refused Reverse now holds: its pause
  // keeps its time but the reason is the person's (payout-pause.ts), so the resumer is told a Reverse was refused, not the old reason.
  // What Resume then does is the rule's (payout-pause.ts): a HELD payout is released when due; a payout the refusal PARKED (Razorpay had let
  // the money go) stays parked until a person resolves it, so that sentence never promises a release there.
  else if (after.pausedAt && before.pausedAt && before.pausedReason !== after.pausedReason && after.pausedReason === REVERSE_PAUSE_REASON) {
    parts.push(
      `it stays paused, now because a person's Reverse was refused (it was paused: ${pauseText(before.pausedReason)}): press Reverse again to take it back, or resume it only if the creator should be paid after all (${after.status === "held" ? "it is then released when due" : "a parked payout stays with a person"})`,
    );
  }
  if (after.releaseAfter && !before.releaseAfter) parts.push("its release is now scheduled");
  // A parked payout that STAYS parked but records a different problem: a refused Reverse re-parks it under the refusal (rollbackReversal), a
  // twin or a mismatch under that, and each alerts staff. Its old reason is gone (and with it any automatic re-check that reason had).
  if (after.status === "needs_attention" && before.status === "needs_attention" && before.errorCode !== undefined && after.errorCode !== undefined && (after.errorCode ?? null) !== (before.errorCode ?? null)) {
    const code = after.errorCode ?? null;
    parts.push(
      code !== null && code === reason
        ? "its recorded problem is now this refusal, in place of the one it was parked for, and staff are alerted by email"
        : `its recorded problem is now ${code === null ? "cleared" : WHY[code] ? `this: ${WHY[code]}` : `a new one (${code})`}, and staff are alerted by email`,
    );
  }
  if (parts.length === 0) return null;
  const s = parts.join(", and ");
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}: see its history.`;
}

/**
 * An action that the engine refused: a 404 for no such payout, else a 409 saying why in plain words (and the code, for the support trail,
 * always LAST: the staff UI splits it off there). `change` is what the step changed all the same (changeSince); without one the refusal says
 * "Nothing was changed.", or the reason's own ending when the step wrote something the row does not show.
 */
function refusal(what: string, r: StepResult, change?: string | null): never {
  if (r.outcome === "not_found") throw new AppError(404, "NOT_FOUND", "Payout not found");
  const code = r.reason ?? r.outcome;
  const ending = change ?? ENDING[r.reason ?? ""] ?? ENDING[r.outcome] ?? "Nothing was changed.";
  throw new AppError(409, "PAYOUT_ACTION_REFUSED", `Not done: ${what}. ${why(r).replace(/^./, (c) => c.toUpperCase())}. ${ending} [${code}]`);
}

/** Refuses with what the step changed since `before` (one more read, on a refusal only). */
async function refusalAfter(what: string, id: string, before: Snapshot, r: StepResult): Promise<never> {
  if (r.outcome === "not_found") refusal(what, r);
  refusal(what, r, changeSince(before, await snapshot(id), r.reason));
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

/**
 * A failed payout is retried: a fresh transfer, made only after ONE read of Razorpay's list of the payment's transfers shows that no live
 * transfer carries this payout's id (an unreadable list refuses it, unless a person attested that no transfer exists). A planned one that never
 * started is run now.
 */
export async function staffRetryTransfer(id: string, staffId: string) {
  const cur = await snapshot(id);
  if (!cur) throw new AppError(404, "NOT_FOUND", "Payout not found");
  if (cur.status === "failed") {
    const r = await retryFailedPayout(id, { actor: staffActor(staffId) });
    // An unknown answer is not a refusal: the payout is transfer_requested and the worker reads Razorpay.
    if (!r.ok && r.outcome !== "unknown" && r.status !== "transfer_requested" && r.status !== "held") await refusalAfter("retry the transfer", id, cur, r);
    return done(id, r);
  }
  if (cur.status === "planned") {
    const r = await executePlannedPayout(id, { actor: staffActor(staffId) });
    if (!r.ok && r.outcome !== "unknown" && r.status === "planned") await refusalAfter("make the transfer", id, cur, r);
    return done(id, r);
  }
  throw new AppError(409, "PAYOUT_ACTION_REFUSED", `Not done: retry the transfer. Only a failed or a planned payout can be retried (this one is ${cur.status}). Nothing was changed.`);
}

/**
 * What a person is told when their Reverse is left to the worker (an unknown, partial or waiting answer, or a reversal already in flight). It
 * states the RULE (payout-pause.ts) for the prior the ENGINE will decide on, never a guess:
 *  • the pause is read off the ROW after the call (the person's pause, REVERSE_PAUSE_REASON, is on it only when the prior was held: written at
 *    the claim, or by the in-flight branch for a held prior — or left there by an earlier refusal that parked the row);
 *  • the prior is the row's status before the call, or, for a reversal that was already in flight, the status it was CLAIMED from, read the
 *    way the worker reads it (priorStatusOfReversal), so a parked payout still carrying the pause is never told "back to held".
 * A held prior still paused: a refusal lands where the engine decides — back in held, still paused and so not released, ONLY while Razorpay
 * still holds the money (decideReversalOutcome); if Razorpay has already let it go (released outside our flow, or settled) the refusal parks
 * it as needs_attention with the pause kept, and the money may settle to the creator. The note cannot know which (its one read just failed,
 * and the row's stored transfer columns predate that read), so it says both. Any other prior: the engine parks a refusal as needs_attention,
 * UNPAUSED unless the pause was already there, and money Razorpay already let go may still settle: that person must not be told it is held.
 */
async function pendingReverseNote(id: string, before: Snapshot): Promise<string> {
  const after = await snapshot(id);
  const prior = before === null ? null : before.status === "reversal_requested" ? await priorStatusOfReversal({ id, releasedAt: before.releasedAt ?? null }) : before.status;
  const heldAndPaused = after?.pausedReason === REVERSE_PAUSE_REASON && prior === "held";
  return heldAndPaused
    ? "The reversal has not been confirmed by Razorpay yet; it is being read back and finished automatically. If Razorpay refuses it while it still holds the money, the payout goes back to held and stays paused, so it is not released; if Razorpay has already let the money go, it is parked as Needs attention, still paused, and may settle to the creator: press Reverse again or check Razorpay."
    : "The reversal has not been confirmed by Razorpay yet; it is being read back and finished automatically. If Razorpay refuses it, the payout is parked as Needs attention for a person and staff are alerted; money already released may still settle to the creator's bank: press Reverse again or check Razorpay.";
}

/**
 * Take the creator's share back out of their linked account (explicit amount, read fresh; never "all"). The engine lets a person do this
 * from `needs_attention` too, and for a released or settlement_failed payout (which Razorpay may only allow against the account's floating
 * balance). A reversal Razorpay has not confirmed is not an error: the payout stays reversal_requested and the worker reads it back.
 */
export async function staffReverse(id: string, staffId: string, reason?: string) {
  // A payout that has no transfer has nothing to take back (a result that stayed unknown and was parked, for one): asking the engine would
  // claim the row, fail to find a transfer, roll back, overwrite the real reason it was parked and send an alert. Refused up front, nothing touched.
  const cur = await prisma.creatorPayout.findUnique({ where: { id }, select: { ...SNAPSHOT_SELECT, razorpayTransferId: true } });
  if (cur && !cur.razorpayTransferId && ["needs_attention", "held", "released", "settlement_failed"].includes(cur.status)) {
    refusal("take this payout back", { ok: false, outcome: "refused", payoutId: id, status: cur.status, calls: 0, reason: "no_transfer" });
  }
  // Scrubbed BEFORE it is cut: cutting first could leave the front of a long number (an account number typed into the reason) unmasked.
  // pauseIfRefused: the person pressed Reverse so that the creator is not paid. A held payout is paused in the same move as the claim, so if
  // Razorpay refuses, now or when the worker reads an unknown answer back, it goes back to held still paused and its scheduled release does
  // not go ahead (a reversal before a refund does not ask for this).
  const r = await reversePayout(id, { actor: staffActor(staffId), reason: scrubStaffText(reason?.trim() || "staff").slice(0, 40), pauseIfRefused: true });
  const pending = r.status === "reversal_requested" || r.outcome === "unknown" || r.outcome === "partial" || r.outcome === "waiting";
  // A reversal Razorpay refused has already been rolled back (held again and paused, or parked for a person, with an alert): the refusal says which.
  if (!r.ok && !pending) await refusalAfter("take this payout back", id, cur, r);
  // One left to the worker: the note says where a refusal would leave it, read off the row (held and paused, or parked unpaused), never assumed.
  return done(id, r, pending ? await pendingReverseNote(id, cur) : undefined);
}

/** Staff paid the creator by bank transfer and record its reference. Refused while a transfer could still release money, and for a post that is not live and verified. */
export async function staffMarkManualPaid(id: string, staffId: string, o: { reference: string; note?: string }) {
  const before = await snapshot(id);
  const r = await markManualPaid(id, { actor: staffActor(staffId), reference: o.reference, note: o.note });
  if (!r.ok && r.status !== "paid_manual") await refusalAfter("record this payment", id, before, r);
  return done(id, r.ok ? r : { ...r, ok: true, outcome: "already_paid_manual" });
}

/**
 * Mark a payout as one that must be paid by bank transfer (planned, failed, reversed or parked); recording the payment is a separate step.
 * The engine refuses it (post_not_live) unless the post is live and verified, except for a PARKED payout: for one whose post never went live
 * this is "Stop this payout" (nothing is owed; the post is then refunded), and markManualPaid still refuses to record a payment for it.
 */
export async function staffRequireManual(id: string, staffId: string, reason: string) {
  // ⚠️ "Reverse first, then pay by hand" is for a post that is LIVE and was delivered. A payout taken back because the post was withdrawn,
  // declined or refunded must not be turned into "pay the creator by bank transfer": that would invite paying for a post the client was refunded for.
  const cur = await prisma.creatorPayout.findUnique({ where: { id }, select: { ...SNAPSHOT_SELECT, bookingItemId: true } });
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
  // The proof that no money is out can find a live transfer and park the payout before it refuses: the refusal says so.
  if (!r.ok) await refusalAfter("mark this payout as to be paid by bank transfer", id, cur, r);
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
  const cur = await prisma.creatorPayout.findUnique({ where: { id }, select: { ...SNAPSHOT_SELECT, bookingItemId: true } });
  if (cur && cur.releaseAfter === null) await onCreatorLinkVerified(cur.bookingItemId, staffActor(staffId));
  const r = await releasePayout(id, { actor: staffActor(staffId) });
  const inFlight = r.status === "release_requested" || r.outcome === "unknown";
  // ⚠️ The gate can write before it refuses: a refund it cannot account for pauses every payout of the payment; a twin transfer parks the
  // payout and takes the extra one back; scheduling the release (above) is itself a change. The refusal names what it finds changed.
  if (!r.ok && !inFlight) await refusalAfter("release this payout", id, cur, r);
  return done(id, r, inFlight ? "The release was requested and Razorpay has not confirmed it yet; it is being read back and finished automatically." : undefined);
}

// ── After looking in the Razorpay dashboard: the human exits of a transfer nobody can see ──

/** The words of the hold check the "no other transfer" attestation runs straight away, so the person sees what it decided. */
function confirmWords(r: StepResult): string {
  if (r.status === "held") return "The transfer is confirmed held.";
  if (r.outcome === "duplicates") return "Razorpay's list shows a second transfer for this payout after all: the extra one is being taken back, and the payout is parked until only one is left.";
  if (r.status === "transfer_requested") return "Razorpay has not finished the transfer yet; the worker confirms the hold within a few minutes.";
  if (r.status === "failed") return "Razorpay shows the transfer failed.";
  if (r.status === "needs_attention") return "The check of the transfer parked the payout again: read its last problem.";
  return "The transfer will be checked again by the worker.";
}

/**
 * A person looked in the Razorpay dashboard and says no transfer carries this payout's id (it records none), or, for a payout whose request
 * was sent twice and that waits on its check for a second transfer, that none OTHER than the recorded one does. Only the person's word is
 * recorded (an audit row with their id): nothing is paid or refunded on it. It stands in for Razorpay's list of the payment's transfers while
 * that list cannot be read, and only where the engine says (manual payment, a Retry, the hold confirmation and the release; never a refund).
 * The "no other" form runs the hold confirmation at once, as the staff member, when the payout is waiting on it.
 */
export async function staffAttestNoTransfer(id: string, staffId: string, note: string) {
  const r = await attestNoTransfer(id, { actor: staffActor(staffId), note });
  if (!r.ok) refusal("record that there is no transfer", r.reason === "transfer_exists" ? { ...r, reason: "transfer_recorded" } : r);
  if (r.outcome === "attested_no_other") {
    const cur = await prisma.creatorPayout.findUnique({ where: { id }, select: { status: true } });
    if (cur?.status === "transfer_requested" || cur?.status === "needs_attention") {
      const c = await confirmHold(id, { actor: staffActor(staffId) });
      return done(id, r, `Recorded: no transfer other than the recorded one carries this payout's id. ${confirmWords(c)}`);
    }
    return done(id, r, "Recorded: no transfer other than the recorded one carries this payout's id. It counts while Razorpay's list of the payment's transfers cannot be read.");
  }
  return done(id, r, "Recorded: no transfer exists for this payout. While Razorpay's list of the payment's transfers cannot be read it stands in for that list for 'Pay by bank transfer instead' and for recording the payment, until the payout is sent to Razorpay again. Nothing else changed.");
}

/**
 * A person found this payout's transfer in the Razorpay dashboard and gives its id. The engine reads THAT transfer and records it only if it is
 * this payout's (its notes carry this payout's id; same linked account, payment and amount), then judges it like any transfer found by a
 * listing: held, failed, a mismatch, or (a request sent twice) waiting for the check for a second transfer.
 */
export async function staffAdoptTransfer(id: string, staffId: string, transferId: string) {
  const want = transferId.trim();
  const r = await adoptTransferByStaff(id, { actor: staffActor(staffId), transferId: want });
  const cur = await prisma.creatorPayout.findUnique({ where: { id }, select: { status: true, razorpayTransferId: true } });
  if (!cur) throw new AppError(404, "NOT_FOUND", "Payout not found");
  if (cur.razorpayTransferId !== want) {
    if (r.outcome === "id_not_recorded") {
      // The payout may have left its park before the id could be written: it is re-checked by the worker, and staff were emailed.
      throw new AppError(409, "PAYOUT_ACTION_REFUSED", `Not done: adopt this transfer. The transfer could not be recorded on this payout (it changed while you were doing this, or the id is in use). The payout is checked again automatically; refresh and look again. [${r.reason ?? r.outcome}]`);
    }
    refusal("adopt this transfer", r);
  }
  // Recorded (now, or by an earlier click: the same answer, safe to repeat).
  let words: string;
  if (cur.status === "held") words = "Recorded: the transfer is this payout's, and it is confirmed held.";
  else if (r.outcome === "audit_pending")
    words =
      "Recorded: the transfer is this payout's. Because its request was sent twice, it is called held only once Razorpay's list of the payment's transfers shows no second transfer for it. If that list still cannot be read, check the dashboard and record that no other transfer carries this payout's id.";
  else if (cur.status === "transfer_requested") words = "Recorded: the transfer is this payout's. Razorpay has not finished it yet; the worker confirms the hold within a few minutes.";
  else if (cur.status === "failed") words = "Recorded: the transfer is this payout's, and Razorpay shows it failed.";
  else words = "Recorded: the transfer is this payout's, but the check of it parked the payout again: read its last problem.";
  return done(id, { ...r, ok: true, outcome: r.outcome === "not_applicable" ? "already_adopted" : r.outcome }, words);
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
