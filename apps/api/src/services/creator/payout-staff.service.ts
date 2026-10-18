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
 *   Every change writes its own creator_payout_events row (actor "staff" + the staff id), which is the audit trail.
 */
import { prisma, Prisma } from "@dashmani/db";
import { AppError } from "../../middleware/error-handler";
import { csvCell } from "../report-links-csv.service";
import { creatorConfig } from "./creator-config";
import { RELEASE_SWITCH_KEY, executePlannedPayout, markManualPaid, pausePayout, releasePayout, releaseSwitchOn, requireManualPayment, resumePayout, retryFailedPayout, reversePayout, type PayoutActor, type StepResult } from "./payout.service";

// ── Filters ─────────────────────────────────────────────────────────────────────

/**
 * The queue's views. `open` is everything that is not finished (settled, paid by hand, void, reversed). The others are the work lists:
 *   needs_attention       parked: Razorpay's facts and ours disagree, or a result stayed unknown
 *   manual_required       Route cannot pay this creator: pay by bank transfer and record the reference
 *   paused                a dispute, an outside refund, a bank change or a staff pause is holding it
 *   held_awaiting_verify  the creator's share is set aside; the post has not been verified yet (no release is scheduled)
 *   releasing             a release is scheduled (verified) or in flight
 *   settlement_pending    released; Razorpay has not settled it to the creator's bank yet
 *   failed                Razorpay refused the transfer, or the bank rejected the settlement
 */
export const PAYOUT_FILTERS = ["open", "needs_attention", "manual_required", "paused", "held_awaiting_verify", "releasing", "settlement_pending", "failed"] as const;
export type PayoutFilter = (typeof PAYOUT_FILTERS)[number];

const TERMINAL = ["settled", "paid_manual", "void", "reversed"];

export const isPayoutFilter = (v: unknown): v is PayoutFilter => typeof v === "string" && (PAYOUT_FILTERS as readonly string[]).includes(v);

export function whereForFilter(f: PayoutFilter): Prisma.CreatorPayoutWhereInput {
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
    default:
      return { status: { notIn: TERMINAL } };
  }
}

/** How many payouts each view holds (the tab badges). */
export async function countsByFilter(): Promise<Record<PayoutFilter, number>> {
  const entries = await Promise.all(PAYOUT_FILTERS.map(async (f) => [f, await prisma.creatorPayout.count({ where: whereForFilter(f) })] as const));
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
  createdAt: Date;
  updatedAt: Date;
  lastEvent: { kind: string; toStatus: string | null; note: string | null; at: Date } | null;
}

/** The names, the page and the latest history line for a page of payouts, in four small queries (the tables carry no relations). */
async function decorate(rows: RowRecord[]): Promise<PayoutRow[]> {
  if (rows.length === 0) return [];
  const [creators, items, bookings, events] = await Promise.all([
    prisma.creator.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.creatorId))] } }, select: { id: true, name: true } }),
    prisma.campaignBookingItem.findMany({ where: { id: { in: rows.map((r) => r.bookingItemId) } }, select: { id: true, accountName: true, platform: true, format: true } }),
    prisma.campaignBooking.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.bookingId))] } }, select: { id: true, name: true } }),
    prisma.creatorPayoutEvent.findMany({
      where: { payoutId: { in: rows.map((r) => r.id) } },
      orderBy: [{ payoutId: "asc" }, { createdAt: "desc" }],
      distinct: ["payoutId"],
      select: { payoutId: true, kind: true, toStatus: true, note: true, createdAt: true },
    }),
  ]);
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
      lastEvent: ev ? { kind: ev.kind, toStatus: ev.toStatus, note: ev.note, at: ev.createdAt } : null,
    };
  });
}

const LIMIT_MAX = 200;

/** The queue: one view, oldest first, with keyset paging (`cursor` = the last id of the previous page) and every view's count. */
export async function listPayoutQueue(o: { filter?: PayoutFilter; limit?: number; cursor?: string | null; bookingId?: string | null; creatorId?: string | null } = {}) {
  const filter = o.filter ?? "open";
  const take = Math.max(1, Math.min(Math.floor(o.limit ?? 50) || 50, LIMIT_MAX));
  const where: Prisma.CreatorPayoutWhereInput = { AND: [whereForFilter(filter), ...(o.bookingId ? [{ bookingId: o.bookingId }] : []), ...(o.creatorId ? [{ creatorId: o.creatorId }] : [])] };
  const rows = await prisma.creatorPayout.findMany({
    where,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: take + 1,
    ...(o.cursor ? { skip: 1, cursor: { id: o.cursor } } : {}),
    select: ROW_SELECT,
  });
  const page = rows.slice(0, take);
  const [shaped, counts, releaseOn] = await Promise.all([decorate(page), countsByFilter(), releaseSwitchOn()]);
  return {
    filter,
    rows: shaped,
    nextCursor: rows.length > take ? page[page.length - 1].id : null,
    counts,
    // What staff must know before acting: whether anything is being released at all, and whether new transfers are being made.
    switches: { release: releaseOn, newTransfers: creatorConfig.routeEnabled(), worker: creatorConfig.payoutCronEnabled() },
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
    ]
      // Every cell is formula-guarded: a creator's name and a page's name are text somebody else chose.
      .map(csvCell)
      .join(",") + "\r\n"
  );
}

/**
 * The queue as a streamed CSV, keyset-paginated in batches of CSV_BATCH (O(batch) memory, whatever the size). The header goes out only
 * AFTER the first batch has been read, so a failure on the first query reaches the route with nothing sent (a clean 500, not an empty
 * 200). Same filters as the queue; returns the number of rows written.
 */
export async function streamPayoutsCsv(o: { filter?: PayoutFilter; bookingId?: string | null; creatorId?: string | null }, write: (chunk: string) => void): Promise<number> {
  const filter = o.filter ?? "open";
  const where: Prisma.CreatorPayoutWhereInput = { AND: [whereForFilter(filter), ...(o.bookingId ? [{ bookingId: o.bookingId }] : []), ...(o.creatorId ? [{ creatorId: o.creatorId }] : [])] };
  let cursor: string | undefined;
  let count = 0;
  let headerWritten = false;
  for (;;) {
    const rows = await prisma.creatorPayout.findMany({
      where,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: CSV_BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: ROW_SELECT,
    });
    if (!headerWritten) {
      write("﻿" + PAYOUT_CSV_HEADERS.map(csvCell).join(",") + "\r\n");
      headerWritten = true;
    }
    if (rows.length === 0) break;
    let chunk = "";
    for (const r of await decorate(rows)) chunk += payoutCsvLine(r);
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
  release_not_scheduled: "no release is scheduled: the post has not been verified",
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
  // resume
  dispute_open: "a dispute is still open on the brand's payment",
  not_paused: "it is not paused",
};

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
  const r = await requireManualPayment(id, { actor: staffActor(staffId), reason: reason.slice(0, 80) });
  if (!r.ok) refusal("mark this payout as to be paid by bank transfer", r);
  return done(id, r);
}

/**
 * Release now: the SAME release gate as the worker (evaluateRelease over fresh facts), run on demand. It cannot bypass anything: a hold that
 * has not run out, an unverified post, a dispute, a pending bank change, a paused payout or the runtime switch each refuse it, with the reason.
 */
export async function staffReleaseNow(id: string, staffId: string) {
  const r = await releasePayout(id, { actor: staffActor(staffId) });
  const inFlight = r.status === "release_requested" || r.outcome === "unknown";
  if (!r.ok && !inFlight) refusal("release this payout", r);
  return done(id, r, inFlight ? "The release was requested and Razorpay has not confirmed it yet; it is being read back and finished automatically." : undefined);
}

// ── The runtime switch ──────────────────────────────────────────────────────────

/** The switch as staff read it. Absent = on. Also what the queue's banner shows. */
export async function getReleaseSwitch(): Promise<{ key: string; release: "on" | "off" }> {
  return { key: RELEASE_SWITCH_KEY, release: (await releaseSwitchOn()) ? "on" : "off" };
}

/**
 * Pause ('off') or resume ('on') EVERY release, with no restart: the engine reads system_settings creatorPayouts.release before each
 * release, so it takes effect on the next one. It stops only the money going OUT; transfers, holds, reversals and refunds carry on.
 * The same change by hand, on the server:
 *   INSERT INTO system_settings (key, value, updated_at) VALUES ('creatorPayouts.release', 'off', timezone('utc', now()))
 *     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;
 * (set 'on', or delete the row, to resume).
 */
export async function setReleaseSwitch(mode: "on" | "off", staffId: string): Promise<{ key: string; release: "on" | "off" }> {
  await prisma.systemSetting.upsert({ where: { key: RELEASE_SWITCH_KEY }, create: { key: RELEASE_SWITCH_KEY, value: mode }, update: { value: mode } });
  console.warn(`[creator-payouts] releases switched ${mode} by staff ${staffId}`);
  return getReleaseSwitch();
}
