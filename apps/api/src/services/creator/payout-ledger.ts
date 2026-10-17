import { randomUUID } from "crypto";
import { prisma, Prisma } from "@dashmani/db";
import { CREATOR_TARGET_TYPE, type CampaignProvider } from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { alertStaffOncePerHour } from "./payout-alert";
import { computePayout, payoutAmountsAreValid } from "./payout-math";

// The creator-payout LEDGER: how a creator's share of a booking is planned, frozen and (until Phase 4 can
// move real money) voided. Everything here is DATABASE ONLY: no Razorpay call is made from this file.
//
//   checkout   freezes each creator item's terms into campaign_bookings.pricing_snapshot  (rate-card.service
//              + payment.service call buildCreatorSnapshotFields)
//   capture    writes ONE `planned` creator_payouts row per creator item, inside the capture transaction
//              (planCreatorPayouts). A page that changed hands since checkout gets a `void` row instead.
//   approve    checks the page owner again (reconcileCreatorOwnership)
//   refund     a creator item is refunded only after its payout is void (ensurePayoutRefundable)
//
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
 * changed hands since the capture has its `planned` payout voided and its item moved to `refund_due`, and staff
 * are told. An item with no payout row at all (it cannot happen, but money is the place not to assume) is treated
 * the same way. Returns the items it moved; approve then carries on with the rest.
 *
 * A mismatch whose payout is already past `planned` throws 409 PAYOUT_NOT_REVERSIBLE_YET (see
 * ensurePayoutRefundable) and the approval does not go ahead.
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
      await ensurePayoutRefundable(p.itemId, { tx, actor: { type: "system" }, reason: p.reason });
      await withdrawOpenOffers(tx, [p.itemId], p.reason === "page_changed" ? "page_taken_over" : "withdrawn", null);
    }
    await tx.campaignBookingEvent.create({
      data: { bookingId, actorType: "system", note: `Creator post(s) need a refund: ${problems.map((p) => `${p.accountName || p.itemId} (${p.reason})`).join(", ")}`.slice(0, 500) },
    });
  });
  alertCreatorItemProblems(bookingId, problems);
  return problems;
}

// ── Refunds: a creator item's money comes back only once its payout is void ─────────────────────

/**
 * Makes sure a creator item's payout can no longer pay anyone, so the brand can be refunded for the item.
 *
 *   no payout row  → nothing to do
 *   `void`         → nothing to do (a retry after a partly failed refund lands here)
 *   `planned`      → voided now (status void + void_reason + a creator_payout_events row)
 *   anything later → 409 PAYOUT_NOT_REVERSIBLE_YET: the creator's share has been sent towards their Razorpay
 *                    account, and giving it back to the brand safely needs the reversal.
 *
 * ⚠️ TODO(Phase 4): replace the body with the real "reverse the held transfer, THEN refund" sequence (claim the
 * item, reverse `transfer.amount − amount_reversed`, confirm, only then let the refund run). Until then, only a
 * `planned` payout (nothing has left our balance) can be refunded, and every other status is refused rather than
 * refunded around, because a refund made while the creator's share sits in their linked account would pay the
 * brand with money that is still the creator's. Callers must treat a throw as "do not refund".
 *
 * Runs inside `opts.tx` when given, else in its own transaction (the void and its audit row never split).
 */
export async function ensurePayoutRefundable(
  itemId: string,
  opts: { tx?: Tx; actor?: PayoutActor; reason?: string } = {},
): Promise<{ payoutId: string | null; voided: boolean }> {
  const reason = (opts.reason ?? "item_refunded").slice(0, 40);
  const actor = opts.actor ?? { type: "system" };
  const notYet = () =>
    new AppError(
      409,
      "PAYOUT_NOT_REVERSIBLE_YET",
      "This creator's share has already been sent towards their payout account, so this post can't be refunded yet: the transfer has to be reversed first, and that step is not available yet. Nothing has been changed.",
    );
  const run = async (tx: Tx) => {
    const payout = await tx.creatorPayout.findUnique({ where: { bookingItemId: itemId }, select: { id: true, bookingId: true, status: true, amountPaise: true } });
    if (!payout) return { payoutId: null, voided: false };
    if (payout.status === "void") return { payoutId: payout.id, voided: false };
    if (payout.status !== "planned") throw notYet();
    const res = await tx.creatorPayout.updateMany({ where: { id: payout.id, status: "planned" }, data: { status: "void", voidReason: reason } });
    // Lost a race with something that moved it on (Phase 4's transfer): same answer as a later status.
    if (res.count !== 1) throw notYet();
    await tx.creatorPayoutEvent.create({
      data: {
        payoutId: payout.id,
        bookingId: payout.bookingId,
        kind: "void",
        fromStatus: "planned",
        toStatus: "void",
        amountPaise: payout.amountPaise,
        actorType: actor.type,
        actorId: actor.id ?? null,
        note: `Voided before any money moved (${reason}).`,
      },
    });
    return { payoutId: payout.id, voided: true };
  };
  return opts.tx ? run(opts.tx) : prisma.$transaction(run);
}

/**
 * Close the offers still open on these items (a creator can no longer accept or post for a campaign that has been
 * refunded or rejected). Conditional, so it never touches an offer that is already finished.
 */
export async function withdrawOpenOffers(tx: Tx, itemIds: string[], closedReason: string, staffId: string | null): Promise<number> {
  if (itemIds.length === 0) return 0;
  const res = await tx.creatorOffer.updateMany({
    where: { bookingItemId: { in: itemIds }, status: { in: ["offered", "accepted"] } },
    data: { status: "withdrawn", withdrawnAt: new Date(), withdrawnById: staffId, closedReason: closedReason.slice(0, 40) },
  });
  return res.count;
}

/**
 * Everything that must happen, in the SAME transaction as claiming a creator item for a refund (refundItem,
 * reject): refuse when the creator has already submitted their link (staff verify it instead), make the payout
 * refundable (ensurePayoutRefundable: void it, or refuse), and withdraw the creator's open offer. A throw rolls
 * the claim back with it.
 */
export async function prepareCreatorItemRefund(
  tx: Tx,
  itemId: string,
  opts: { actor?: PayoutActor; reason: string; closedReason: string },
): Promise<void> {
  const submitted = await tx.creatorOffer.count({ where: { bookingItemId: itemId, status: { in: ["offered", "accepted"] }, linkSubmittedAt: { not: null } } });
  if (submitted > 0) {
    throw new AppError(409, "CREATOR_LINK_SUBMITTED", "The creator has already submitted the link for this post. Check the link and mark it posted instead of refunding it.");
  }
  await ensurePayoutRefundable(itemId, { tx, actor: opts.actor, reason: opts.reason });
  await withdrawOpenOffers(tx, [itemId], opts.closedReason, opts.actor?.type === "staff" ? opts.actor.id ?? null : null);
}

// ── Offers: when a creator may hand in their link, and what verifying it will start ──────────────

/**
 * Whether a creator's payout is in a state in which a post may be accepted for it (the creator submits their link,
 * staff verify it). A void, failed, reversed or unknown-result payout means there is no money behind the post, so the
 * link is refused: the item is refunded instead.
 *
 * TODO(Phase 4): tighten this to `held` ONLY (the share is confirmed set aside in the creator's linked account before
 * their post is accepted). Today only `planned` exists, so `transfer_requested` and `held` are listed for the moment
 * the transfer leg starts writing them; until then this is exactly "a planned payout".
 */
export function payoutAllowsLink(status: string): boolean {
  return status === "planned" || status === "transfer_requested" || status === "held";
}

/**
 * Called after staff verified a creator's link and the item went live (review.verifyCreatorLink). It does NOTHING in
 * Phase 3: no money moves when a link is verified, and the payout stays exactly as it was.
 *
 * TODO(Phase 4): this is where the release starts. Claim the payout (`updateMany WHERE status = 'held' AND paused_at IS
 * NULL`), wait out `release_after` (at least one day when ownership was checked by hand), re-fetch the transfer and only
 * then `PATCH on_hold:false`. It must never throw into the caller: a failure here is the reconciliation worker's to retry,
 * never a reason to undo a verification that already committed.
 */
export async function onCreatorLinkVerified(_itemId: string): Promise<void> {
  return;
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
