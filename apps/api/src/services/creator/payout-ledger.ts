import { randomUUID } from "crypto";
import { prisma, Prisma } from "@dashmani/db";
import { CREATOR_TARGET_TYPE, type CampaignProvider } from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { alertStaffOncePerHour } from "./payout-alert";
import { computePayout, payoutAmountsAreValid } from "./payout-math";
import { reverseForRefund, scheduleRelease, type RefundReadiness } from "./payout.service";

// The creator-payout LEDGER: how a creator's share of a booking is planned and frozen, and the small rules the
// offer, refund and approval code share about a payout's state.
//
//   checkout   freezes each creator item's terms into campaign_bookings.pricing_snapshot  (rate-card.service
//              + payment.service call buildCreatorSnapshotFields)
//   capture    writes ONE `planned` creator_payouts row per creator item, inside the capture transaction
//              (planCreatorPayouts). A page that changed hands since checkout gets a `void` row instead.
//   approve    checks the page owner again (reconcileCreatorOwnership)
//   refund     a creator item is refunded only after its payout is void or reversed (ensurePayoutRefundable here;
//              the whole sequence lives in creator-refund.service)
//   verified   onCreatorLinkVerified schedules the release; the reconciliation worker does the releasing
//
// ⚠️ NOTHING IN A TRANSACTION CALLS RAZORPAY. The functions that take a `tx` here only read and write our own rows. The
// ones that talk to Razorpay (ensurePayoutRefundable) take no transaction and must be called outside one.

// ⚠️ A payout row freezes what the creator is owed AT CHECKOUT. Nothing here ever recomputes it from a rate
// card, a share or a TDS rate read later: the brand paid for exactly those figures.

type Tx = Prisma.TransactionClient;

/** campaign_booking_items.target_type / campaign_rate_cards.target_type of a creator's page. */
export const CREATOR_TARGET = CREATOR_TARGET_TYPE;

/** Payouts whose money has settled one way or the other: a page with only these (and no open offer) is free to change hands. */
export const FINISHED_PAYOUT_STATUSES = ["settled", "paid_manual", "void", "reversed"] as const;

export interface PayoutActor {
  type: "system" | "staff" | "creator" | "razorpay";
  id?: string | null;
}

// ── What checkout freezes ───────────────────────────────────────────────────────────────────────

/** The terms frozen for one creator item, as stored on its entry in pricing_snapshot.items. */
export interface CreatorSnapshotItem {
  itemId: string;
  /** The creator who owned the page at checkout: compared with the page's owner at capture and at approve. */
  creatorId: string;
  payoutAccountId: string;
  razorpayAccountId: string;
  shareBps: number;
  tdsBps: number;
  /** The item's price (base + any song add-on): what the brand pays for this post. */
  itemPricePaise: number;
  grossPaise: number;
  tdsPaise: number;
  /** What the creator is shown and is sent: gross − tds. */
  amountPaise: number;
  assetName: string;
  handle: string | null;
  /** The creator's display name, shown to the brand as the post's provider (payer-payee transparency). */
  creatorName: string;
}

/**
 * The creator keys added to ONE entry of pricing_snapshot.items, flat next to `pricePaise`, `accountName`…
 * Network entries never get them, so a network-only booking's snapshot is byte-identical to before.
 */
export function buildCreatorSnapshotFields(o: {
  creatorId: string;
  creatorName: string;
  payoutAccountId: string;
  razorpayAccountId: string;
  shareBps: number;
  tdsBps: number;
  itemPricePaise: number;
  assetName: string;
  handle: string | null;
}) {
  const { grossPaise, tdsPaise, amountPaise } = computePayout(o.itemPricePaise, o.shareBps, o.tdsBps);
  return {
    creatorId: o.creatorId,
    creatorName: o.creatorName,
    payoutAccountId: o.payoutAccountId,
    razorpayAccountId: o.razorpayAccountId,
    shareBps: o.shareBps,
    tdsBps: o.tdsBps,
    grossPaise,
    tdsPaise,
    amountPaise,
    assetName: o.assetName,
    handle: o.handle,
  };
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * The creator entries of a booking's pricing snapshot. Defensive: it is JSON read back from the database, so an
 * entry that is missing a field, or whose figures break the payout rules, is DROPPED, and the caller treats that
 * item as having no usable frozen terms (it never guesses one).
 */
export function creatorItemsOfSnapshot(snapshot: unknown): CreatorSnapshotItem[] {
  const items = (snapshot as { items?: unknown } | null | undefined)?.items;
  if (!Array.isArray(items)) return [];
  const out: CreatorSnapshotItem[] = [];
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) continue;
    const e = raw as Record<string, unknown>;
    if (!isStr(e.creatorId)) continue; // a network entry
    if (
      !isStr(e.itemId) || !isStr(e.payoutAccountId) || !isStr(e.razorpayAccountId) ||
      !isInt(e.shareBps) || !isInt(e.tdsBps) || !isInt(e.pricePaise) || !isInt(e.grossPaise) || !isInt(e.tdsPaise) || !isInt(e.amountPaise)
    ) continue;
    const f: CreatorSnapshotItem = {
      itemId: e.itemId,
      creatorId: e.creatorId,
      payoutAccountId: e.payoutAccountId,
      razorpayAccountId: e.razorpayAccountId,
      shareBps: e.shareBps,
      tdsBps: e.tdsBps,
      itemPricePaise: e.pricePaise,
      grossPaise: e.grossPaise,
      tdsPaise: e.tdsPaise,
      amountPaise: e.amountPaise,
      assetName: typeof e.assetName === "string" ? e.assetName : typeof e.accountName === "string" ? e.accountName : "",
      handle: typeof e.handle === "string" ? e.handle : null,
      creatorName: typeof e.creatorName === "string" ? e.creatorName : "",
    };
    if (f.shareBps > 10_000 || f.tdsBps > 10_000 || !payoutAmountsAreValid(f)) continue;
    out.push(f);
  }
  return out;
}

/**
 * Who provides a post, for the CLIENT: a creator's page is NAMED (payer-payee transparency: the client always
 * knows who is paid for a post), our own network is not. The name is the one frozen at checkout; before checkout
 * it is the page's current owner. Nothing else of the creator is exposed.
 */
export async function providersOfItems(b: { pricingSnapshot?: unknown; items?: Array<{ id: string; targetType: string; targetId: string }> }): Promise<Map<string, CampaignProvider>> {
  const out = new Map<string, CampaignProvider>();
  const creatorItems = (b.items ?? []).filter((i) => i.targetType === CREATOR_TARGET_TYPE);
  if (creatorItems.length === 0) return out;
  const frozen = new Map(creatorItemsOfSnapshot(b.pricingSnapshot).map((f) => [f.itemId, f.creatorName]));
  const needLive = creatorItems.filter((i) => !frozen.get(i.id));
  const live = needLive.length
    ? await prisma.creatorAsset.findMany({ where: { id: { in: needLive.map((i) => i.targetId) } }, select: { id: true, creator: { select: { name: true } } } })
    : [];
  const liveName = new Map(live.map((a) => [a.id, a.creator.name]));
  for (const i of creatorItems) out.set(i.id, { type: "creator", name: frozen.get(i.id) || liveName.get(i.targetId) || null });
  return out;
}

// ── Capture: plan one payout per creator item ───────────────────────────────────────────────────

/** An item that was paid for but can't go ahead: it goes `refund_due` and staff are told. */
export interface CreatorItemProblem {
  itemId: string;
  accountName: string;
  /** page_changed: the page has a different owner than at checkout. terms_missing: no usable frozen terms. */
  reason: "page_changed" | "terms_missing";
}

const PROBLEM_TEXT: Record<CreatorItemProblem["reason"], string> = {
  page_changed: "The page changed hands after checkout, so the creator who was booked no longer owns it. Refund this one.",
  terms_missing: "This post has no usable frozen creator terms, so no payout could be planned. Refund this one.",
};

/** Staff alert for items that went refund_due. Call it AFTER the transaction that found them has committed. */
export function alertCreatorItemProblems(bookingId: string, problems: CreatorItemProblem[]): void {
  if (problems.length === 0) return;
  alertStaffOncePerHour(
    `creator-item-refund-due:${bookingId}`,
    "A creator's post can't go ahead and needs a refund",
    [
      { label: "Campaign", value: bookingId },
      ...problems.map((p) => ({ label: p.accountName || p.itemId, value: PROBLEM_TEXT[p.reason] })),
    ],
    `/campaigns/${bookingId}`,
  );
}

/**
 * Inside the capture transaction, AFTER the booking has moved to paid_pending_review: write one payout row per
 * creator item from the terms frozen at checkout, with the WINNING razorpay payment id.
 *
 *   • the page's owner now equals the creator frozen at checkout → a `planned` row;
 *   • the owner differs (or the page is gone) → a `void` row (void_reason page_changed): no money is ever
 *     planned for someone who no longer owns the page, and the item goes `refund_due`;
 *   • the frozen terms are missing or break the payout rules → no row (there are no figures to write), the item
 *     goes `refund_due`.
 * Idempotent: a payout already on file for an item is left alone (booking_item_id is UNIQUE), so a replay can
 * neither double a row nor double its audit event. A network-only booking has no creator items and costs one
 * indexed query.
 *
 * ⚠️ Runs inside the caller's transaction on purpose: a failure anywhere rolls the payout rows back with the
 * claim, the booking move and everything else, and Razorpay's redelivery starts clean. Never call Razorpay or
 * send mail from here.
 */
export async function planCreatorPayouts(
  tx: Tx,
  bookingId: string,
  razorpayPaymentId: string,
): Promise<{ planned: number; problems: CreatorItemProblem[] }> {
  const items = await tx.campaignBookingItem.findMany({
    where: { bookingId, targetType: CREATOR_TARGET },
    orderBy: { id: "asc" },
    select: { id: true, targetId: true, accountName: true, pricePaise: true, status: true },
  });
  if (items.length === 0) return { planned: 0, problems: [] };

  const booking = await tx.campaignBooking.findUnique({ where: { id: bookingId }, select: { pricingSnapshot: true } });
  const frozen = new Map(creatorItemsOfSnapshot(booking?.pricingSnapshot).map((f) => [f.itemId, f]));
  const assets = await tx.creatorAsset.findMany({ where: { id: { in: items.map((i) => i.targetId) } }, select: { id: true, creatorId: true } });
  const owner = new Map(assets.map((a) => [a.id, a.creatorId]));
  const already = new Set((await tx.creatorPayout.findMany({ where: { bookingItemId: { in: items.map((i) => i.id) } }, select: { bookingItemId: true } })).map((p) => p.bookingItemId));

  const problems: CreatorItemProblem[] = [];
  const rows: Prisma.CreatorPayoutCreateManyInput[] = [];
  const events: Prisma.CreatorPayoutEventCreateManyInput[] = [];
  let planned = 0;

  for (const item of items) {
    const f = frozen.get(item.id);
    if (!f || f.itemPricePaise !== item.pricePaise) {
      problems.push({ itemId: item.id, accountName: item.accountName, reason: "terms_missing" });
      continue;
    }
    if (already.has(item.id)) continue;
    const changed = owner.get(item.targetId) !== f.creatorId;
    const id = randomUUID();
    rows.push({
      id,
      bookingId,
      bookingItemId: item.id,
      creatorId: f.creatorId,
      payoutAccountId: f.payoutAccountId,
      razorpayAccountId: f.razorpayAccountId,
      razorpayPaymentId,
      status: changed ? "void" : "planned",
      voidReason: changed ? "page_changed" : null,
      itemPricePaise: f.itemPricePaise,
      shareBps: f.shareBps,
      grossPaise: f.grossPaise,
      tdsBps: f.tdsBps,
      tdsPaise: f.tdsPaise,
      amountPaise: f.amountPaise,
    });
    events.push({
      payoutId: id,
      bookingId,
      kind: changed ? "void" : "planned",
      fromStatus: null,
      toStatus: changed ? "void" : "planned",
      amountPaise: f.amountPaise,
      actorType: "system",
      note: changed ? "Not planned: the page changed hands between checkout and payment." : "Planned when the brand's payment was captured.",
    });
    if (changed) problems.push({ itemId: item.id, accountName: item.accountName, reason: "page_changed" });
    else planned++;
  }

  if (rows.length > 0) {
    await tx.creatorPayout.createMany({ data: rows, skipDuplicates: true });
    await tx.creatorPayoutEvent.createMany({ data: events });
  }
  if (problems.length > 0) {
    // The reason is written on the item itself, so staff see it on the row without digging through History.
    for (const p of problems) {
      await tx.campaignBookingItem.updateMany({ where: { id: p.itemId, status: "pending" }, data: { status: "refund_due", lastError: PROBLEM_TEXT[p.reason].slice(0, 500) } });
    }
    await tx.campaignBookingEvent.create({
      data: {
        bookingId,
        actorType: "system",
        note: `Creator post(s) need a refund: ${problems.map((p) => `${p.accountName || p.itemId} (${p.reason})`).join(", ")}`.slice(0, 500),
      },
    });
  }
  return { planned, problems };
}

// ── Approve: the page must still belong to the creator who was booked ───────────────────────────

/**
 * At approve: every creator item still `pending` is checked against its page's CURRENT owner. A page that
 * changed hands since the capture has its item moved to `refund_due` (and any offer withdrawn), and staff are
 * told. An item with no payout row at all (it cannot happen, but money is the place not to assume) is treated
 * the same way. Returns the items it moved; approve then carries on with the rest.
 *
 * ⚠️ THIS CLAIMS ONLY, AND IT CLAIMS IN ONE TRANSACTION THAT NEVER TALKS TO RAZORPAY. The item's payout may by now
 * be `held` (the creator's share already set aside in their linked account), and taking that back is a Razorpay
 * call. So the transaction only moves the item to `refund_due`; the payout worker (cron/creator-payouts.cron.ts, job
 * 10, creator-refund.service progressCreatorItemRefund) then makes each payout refundable OUTSIDE any transaction (void
 * it, or reverse it, and only then refund the brand). It is deliberately left to the worker a few minutes later, not
 * done inline: the "approved" email is built from the items' statuses and must still find these refund_due.
 * Approval is therefore never refused because a transfer has to be reversed.
 */
export async function reconcileCreatorOwnership(bookingId: string): Promise<CreatorItemProblem[]> {
  // Only a booking that is waiting for approval: approving anything else is refused by the caller, and must not
  // have moved an item to refund_due on its way to being refused.
  const booking = await prisma.campaignBooking.findUnique({ where: { id: bookingId }, select: { status: true } });
  if (booking?.status !== "paid_pending_review") return [];
  const items = await prisma.campaignBookingItem.findMany({
    where: { bookingId, targetType: CREATOR_TARGET, status: "pending" },
    select: { id: true, targetId: true, accountName: true },
  });
  if (items.length === 0) return [];
  const payouts = await prisma.creatorPayout.findMany({ where: { bookingItemId: { in: items.map((i) => i.id) } }, select: { bookingItemId: true, creatorId: true } });
  const byItem = new Map(payouts.map((p) => [p.bookingItemId, p]));
  const assets = await prisma.creatorAsset.findMany({ where: { id: { in: items.map((i) => i.targetId) } }, select: { id: true, creatorId: true } });
  const owner = new Map(assets.map((a) => [a.id, a.creatorId]));

  const problems: CreatorItemProblem[] = [];
  for (const item of items) {
    const payout = byItem.get(item.id);
    if (!payout) problems.push({ itemId: item.id, accountName: item.accountName, reason: "terms_missing" });
    else if (owner.get(item.targetId) !== payout.creatorId) problems.push({ itemId: item.id, accountName: item.accountName, reason: "page_changed" });
  }
  if (problems.length === 0) return [];

  await prisma.$transaction(async (tx) => {
    for (const p of problems) {
      const claim = await tx.campaignBookingItem.updateMany({
        where: { id: p.itemId, status: "pending" },
        data: { status: "refund_due", lastError: PROBLEM_TEXT[p.reason].slice(0, 500) },
      });
      if (claim.count !== 1) continue;
      await withdrawOpenOffers(tx, [p.itemId], p.reason === "page_changed" ? "page_taken_over" : "withdrawn", null);
    }
    await tx.campaignBookingEvent.create({
      data: { bookingId, actorType: "system", note: `Creator post(s) need a refund: ${problems.map((p) => `${p.accountName || p.itemId} (${p.reason})`).join(", ")}`.slice(0, 500) },
    });
  });
  alertCreatorItemProblems(bookingId, problems);
  return problems;
}

// ── Refunds: a creator item's money comes back only once its payout is void or reversed ────────

/** What a refund guard needs to know about the item's payout. */
export interface PayoutRefundFacts {
  status: string;
  reversedAt: Date | null;
  razorpayTransferId: string | null;
  attempts: number;
}

/**
 * Whether claiming a creator item for a refund may go ahead, judged from the payout's status ALONE (no Razorpay
 * call, so it is safe inside the claiming transaction). null = go ahead: the payout can be made refundable AFTER
 * the claim commits (planned/failed → void, held → reversed) or it must simply be waited for (transfer_requested:
 * the item waits as refund_due until the transfer settles into `held`, because no refund may start while a transfer
 * can still be created [R4]). Anything else is refused BEFORE a single row is changed:
 *
 *   release_requested                         → 409 PAYOUT_BUSY: a release is in flight, and either outcome changes the answer
 *   released, settlement_failed, settled, paid_manual
 *                                             → 409 PAYOUT_PAID_OUT: the money has left (or is leaving) for the creator's bank.
 *                                               A person reverses it from the payout queue first, then refunds.
 *   needs_attention, manual_required (unproven) → 409 PAYOUT_NEEDS_ATTENTION: the facts and our row disagree; a person decides.
 */
export function payoutRefundGuard(p: PayoutRefundFacts | null | undefined): AppError | null {
  if (!p) return null;
  switch (p.status) {
    case "planned":
    case "failed":
    case "void":
    case "reversed":
    case "held":
    case "reversal_requested":
    case "transfer_requested":
      return null;
    case "manual_required":
      // Voidable only when no money is out or it came back (the engine's own proof in reverseForRefund).
      return p.reversedAt !== null || (p.razorpayTransferId === null && p.attempts === 0)
        ? null
        : new AppError(409, "PAYOUT_NEEDS_ATTENTION", "This creator's payout is waiting to be paid by hand and may already have money out, so it can't be refunded from here. Check it in the payout queue first. Nothing has been changed.");
    case "release_requested":
      return new AppError(409, "PAYOUT_BUSY", "This creator's payout is being released right now. Wait a few minutes and try again. Nothing has been changed.");
    case "released":
    case "settlement_failed":
    case "settled":
    case "paid_manual":
      return new AppError(
        409,
        "PAYOUT_PAID_OUT",
        "This creator's payout has already been released or paid out, so this post can't be refunded from here. If it really must be refunded, take the payout back first from the payout queue (Reverse), then refund the post. Nothing has been changed.",
      );
    default:
      return new AppError(409, "PAYOUT_NEEDS_ATTENTION", "This creator's payout needs a person to look at it before this post can be refunded. Nothing has been changed.");
  }
}

/**
 * Makes sure a creator item's payout can no longer pay anyone, so the brand can be refunded for the item (reverse
 * BEFORE refund). Talks to Razorpay, so it must be called OUTSIDE any transaction and with the item already claimed
 * (creator-refund.service does that).
 *
 *   no payout row       → nothing to do
 *   `void` / `reversed` → nothing to do (a retry after a partly failed refund lands here)
 *   `planned`, `failed` → voided now (nothing was ever transferred)
 *   `held`              → the transfer is reversed (explicit amount, read fresh; never reverse_all)
 *   `transfer_requested`→ 409 PAYOUT_BUSY: the item waits as refund_due, and the worker refunds it once the transfer is held and reversed
 *   reversal in flight  → 409 PAYOUT_BUSY: asked again later
 *   released / settled  → 409 PAYOUT_PAID_OUT: already paid out; a person reverses it from the payout queue first
 *   anything else       → 409 PAYOUT_NEEDS_ATTENTION / PAYOUT_NOT_REVERSIBLE_YET
 * Callers must treat a throw as "do not refund". The non-throwing form is reverseForRefund (payout.service).
 */
export async function ensurePayoutRefundable(
  itemId: string,
  opts: { actor?: PayoutActor; reason?: string; now?: Date } = {},
): Promise<{ payoutId: string | null; voided: boolean; reversed: boolean; state: RefundReadiness["state"] }> {
  const reason = (opts.reason ?? "item_refunded").slice(0, 40);
  const r = await reverseForRefund(itemId, { actor: opts.actor ?? { type: "system" }, reason, now: opts.now });
  if (r.refundable) return { payoutId: r.payoutId, voided: r.state === "voided", reversed: r.state === "reversed", state: r.state };
  if (r.state === "in_flight") {
    throw new AppError(409, "PAYOUT_BUSY", "This creator's share is still being set aside, so it can't be taken back yet. The post is refunded automatically as soon as that has finished. Nothing is lost.");
  }
  if (r.state === "reversal_pending") {
    throw new AppError(409, "PAYOUT_BUSY", "The creator's share is being taken back from their payout account and Razorpay hasn't confirmed it yet. The post is refunded automatically as soon as it has. Nothing is lost.");
  }
  if (r.reason === "payout_release_requested") {
    throw new AppError(409, "PAYOUT_BUSY", "This creator's payout is being released right now. Wait a few minutes and try again. Nothing has been changed.");
  }
  if (/^payout_(released|settled|settlement_failed|paid_manual)$/.test(r.reason ?? "")) {
    throw new AppError(409, "PAYOUT_PAID_OUT", "This creator's payout has already been released or paid out, so this post can't be refunded from here. Take the payout back first from the payout queue (Reverse), then refund the post.");
  }
  if (/needs_attention|manual_required|payout_moved/.test(r.reason ?? "")) {
    throw new AppError(409, "PAYOUT_NEEDS_ATTENTION", "This creator's payout needs a person to look at it before this post can be refunded. Nothing has been changed.");
  }
  throw new AppError(409, "PAYOUT_NOT_REVERSIBLE_YET", "Razorpay did not take the creator's share back, so this post can't be refunded yet. Nothing has been changed; the payout queue shows why.");
}

/** An offer closed by withdrawOpenOffers, as it stood just before: enough to tell its creator (sendOfferWithdrawnEmails) and nothing more. */
export interface WithdrawnOffer {
  id: string;
  creatorId: string;
  pageName: string;
  platform: string;
  format: string;
  /** `offered` or `accepted`. An offer that was never emailed and never accepted needs no word to its creator. */
  status: string;
  notifiedAt: Date | null;
}

/**
 * Close the offers still open on these items (a creator can no longer accept or post for a campaign that has been
 * refunded or rejected). Conditional, so it never touches an offer that is already finished. `collect`, when given, receives
 * the offers it is about to close, read in the same transaction.
 */
export async function withdrawOpenOffers(tx: Tx, itemIds: string[], closedReason: string, staffId: string | null, collect?: WithdrawnOffer[]): Promise<number> {
  if (itemIds.length === 0) return 0;
  // What the creator had seen, read BEFORE it is closed (and in the same transaction), so the caller can tell them once it commits.
  if (collect) {
    const before = await tx.creatorOffer.findMany({
      where: { bookingItemId: { in: itemIds }, status: { in: ["offered", "accepted"] } },
      select: { id: true, creatorId: true, pageName: true, platform: true, format: true, status: true, notifiedAt: true },
    });
    collect.push(...before);
  }
  const res = await tx.creatorOffer.updateMany({
    where: { bookingItemId: { in: itemIds }, status: { in: ["offered", "accepted"] } },
    data: { status: "withdrawn", withdrawnAt: new Date(), withdrawnById: staffId, closedReason: closedReason.slice(0, 40) },
  });
  return res.count;
}

/**
 * Everything that must happen, in the SAME transaction as claiming a creator item for a refund (refundItem,
 * reject): refuse when the creator has already submitted their link (staff verify it instead), refuse when the
 * payout is somewhere a refund must not touch (payoutRefundGuard: already released or paid out, or needing a person),
 * and withdraw the creator's open offer. A throw rolls the claim back with it.
 *
 * ⚠️ The payout itself is NOT touched here: voiding it or reversing its transfer happens after this transaction has
 * committed (creator-refund.service progressCreatorItemRefund), because a reversal is a Razorpay call and no network
 * call may sit inside a transaction. The offer is withdrawn FIRST on purpose: it closes the creator's way to accept or
 * post for this item, so nothing can start behind the reversal's back.
 */
export async function prepareCreatorItemRefund(
  tx: Tx,
  itemId: string,
  opts: { actor?: PayoutActor; reason: string; closedReason: string; withdrawn?: WithdrawnOffer[] },
): Promise<void> {
  const submitted = await tx.creatorOffer.count({ where: { bookingItemId: itemId, status: { in: ["offered", "accepted"] }, linkSubmittedAt: { not: null } } });
  if (submitted > 0) {
    throw new AppError(409, "CREATOR_LINK_SUBMITTED", "The creator has already submitted the link for this post. Check the link and mark it posted instead of refunding it.");
  }
  const payout = await tx.creatorPayout.findUnique({ where: { bookingItemId: itemId }, select: { status: true, reversedAt: true, razorpayTransferId: true, attempts: true } });
  const refused = payoutRefundGuard(payout);
  if (refused) throw refused;
  await withdrawOpenOffers(tx, [itemId], opts.closedReason, opts.actor?.type === "staff" ? opts.actor.id ?? null : null, opts.withdrawn);
}

// ── Offers: when a creator may hand in their link, and what verifying it will start ──────────────

/**
 * Whether a creator's payout is in a state in which a post may be accepted for it (the creator submits their link,
 * staff verify it): ONLY `held`, meaning Razorpay has confirmed the creator's share is processed and on hold in their
 * linked account. A planned or still-requested transfer, and a void, failed, reversed or unknown-result payout, mean
 * there is no confirmed money behind the post, so nothing is accepted and no link is verified.
 */
export function payoutAllowsLink(status: string): boolean {
  return status === "held";
}

/**
 * Called after staff verified a creator's link and the item went live (review.verifyCreatorLink): it SCHEDULES the
 * release and does nothing else. release_after = verified_at + CREATOR_PAYOUT_HOLD_DAYS, and at least one day when the
 * ownership of the post was checked by hand (scheduleRelease). The reconciliation worker then releases the payout when
 * release_after has passed AND the whole release gate holds on fresh facts (payout-policy evaluateRelease): it is never
 * released inline from a staff click.
 *
 * ⚠️ By the time this runs the creator's offer is `completed` (verifyCreatorItem moves it there together with stamping
 * link_verified_at): the gate reads link_verified_at, never `status = 'accepted'`. It must never throw into the caller: a
 * failure here is the worker's to repair, never a reason to undo a verification that already committed.
 */
export async function onCreatorLinkVerified(itemId: string, actor: PayoutActor = { type: "system" }): Promise<void> {
  try {
    const offer = await prisma.creatorOffer.findUnique({ where: { bookingItemId: itemId }, select: { ownershipCheck: true, linkVerifiedAt: true } });
    if (!offer?.linkVerifiedAt) return;
    await scheduleRelease(itemId, { ownershipCheck: offer.ownershipCheck, verifiedAt: offer.linkVerifiedAt, actor });
  } catch (err) {
    console.error(`[payout-ledger] could not schedule a release: ${(err as Error)?.message ?? "error"}`.slice(0, 200));
  }
}

// ── Pages with work still open ──────────────────────────────────────────────────────────────────

/**
 * Whether a page (creator_assets.id) still has work in flight: an offer that is offered or accepted, or a payout
 * that has not settled. There is deliberately no foreign key from offers or payouts to creator_assets (the page
 * name is snapshotted), so this is the guard that keeps a page from changing hands, or being purged, while a
 * brand's money or a creator's post depends on it. Payouts are found through their booking item.
 */
export async function pagesWithOpenWork(assetIds: string[]): Promise<Set<string>> {
  const busy = new Set<string>();
  if (assetIds.length === 0) return busy;
  const offers = await prisma.creatorOffer.findMany({
    where: { creatorAssetId: { in: assetIds }, status: { in: ["offered", "accepted"] } },
    select: { creatorAssetId: true },
    distinct: ["creatorAssetId"],
  });
  for (const o of offers) busy.add(o.creatorAssetId);
  const payouts = await prisma.$queryRaw<Array<{ target_id: string }>>`
    SELECT DISTINCT i.target_id
      FROM creator_payouts p
      JOIN campaign_booking_items i ON i.id = p.booking_item_id
     WHERE i.target_type = ${CREATOR_TARGET}
       AND i.target_id = ANY(${assetIds})
       AND p.status <> ALL(${[...FINISHED_PAYOUT_STATUSES]})`;
  for (const r of payouts) busy.add(r.target_id);
  return busy;
}

export async function pageHasOpenWork(assetId: string): Promise<boolean> {
  return (await pagesWithOpenWork([assetId])).has(assetId);
}

/**
 * A page changed hands: its rate cards stop being offered AND lose their share, so the new owner starts from
 * nothing and staff must price and share the page again. (The card rows stay, inactive, for the audit trail.)
 */
export async function clearPageRateCards(assetId: string): Promise<void> {
  await prisma.$transaction([
    prisma.creatorRateTerm.deleteMany({ where: { rateCard: { targetType: CREATOR_TARGET, targetId: assetId } } }),
    prisma.campaignRateCard.updateMany({ where: { targetType: CREATOR_TARGET, targetId: assetId }, data: { active: false } }),
  ]);
}
