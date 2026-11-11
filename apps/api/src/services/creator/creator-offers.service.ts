import { prisma, type Prisma } from "@dashmani/db";
import { formatLabelFor, isPlatformPostUrl, platformPostLinkError, todayIST, type CampaignPlatform } from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { scrubSecrets } from "../../utils/token-crypto";
import { campaignConfig } from "../campaign/config";
import { signedMediaPath } from "../campaign/media-url";
import { itemText, logBookingEvent, resolveItemFiles, settleBooking, type Actor } from "../campaign/booking.service";
import { checkEligibility, launchAt } from "../campaign/publish.service";
import { sendDeliveryEmail, sendItemLiveEmail, sendCreatorDeclinedEmail } from "../campaign/delivery.service";
import { adminAlert, button, creatorLink, CREATOR_SUPPORT_EMAIL, esc, sendCreatorEmail } from "./creator-email";

// Creator marketplace (creator portal Phase B): a client books a creator's page, our team
// approves the campaign, and the post is OFFERED to the creator, who accepts or declines it.
//
// ⚠️ THE RULES THIS FILE EXISTS TO KEEP:
//  • Nothing is posted on a creator's page without that creator's accept. Approval moves a
//    creator item to `awaiting_creator`; only acceptOffer() moves it on (queued = we publish it
//    through the creator's own grant on the launch day; manual_pending = the API can't, so the
//    creator — or staff — posts it and records the link).
//  • The decision belongs to the creator who owned the page WHEN the post was offered
//    (`creator_id` is frozen then). A page that later changed hands, was disconnected or whose
//    creator was suspended can no longer be accepted.
//  • Never fail a paid item silently. A decline — or no answer by `creator_respond_by` — moves
//    the item to `creator_declined` and alerts staff, who refund or drop it (review.service).
//  • Every change is a conditional updateMany on the item's current status, so an accept and the
//    expiry job (or two clicks) cannot both win.
//  • The creator sees what will be posted (brand, text, the rendered files) and their payout —
//    never the client's identity or what the client paid.

type Tx = Prisma.TransactionClient;
const SYSTEM: Actor = { type: "system" };
const creatorActor = (id: string): Actor => ({ type: "creator", id });

/** Shortest window we ever give a creator to answer, whatever the posting dates say. */
const MIN_RESPONSE_MS = 6 * 3600_000;
/** Offers expired per job run (the job runs every 10 minutes). */
const EXPIRE_BATCH = 50;
const BOOKING_LIVE = ["approved", "publishing"];
/** A recorded link may still be corrected after the campaign settles (the client keeps the link). */
const BOOKING_CORRECTABLE = ["approved", "publishing", "completed", "partially_published"];
/** Answer-by reminder: sent once, this long before the deadline… */
const REMIND_BEFORE_MS = 24 * 3600_000;
/** …and only when the offer gave the creator more than this, so a short window gets one email, not two. */
const REMIND_MIN_WINDOW_MS = 30 * 3600_000;

/**
 * When the creator must have answered: CREATOR_RESPONSE_HOURS (72) after the offer, but no later
 * than the end of the campaign's last posting day (IST), and never sooner than 6 hours.
 */
export function respondByFor(offeredAt: Date, launchTo: Date | null): Date {
  let by = offeredAt.getTime() + campaignConfig.creatorResponseHours() * 3600_000;
  if (launchTo) {
    // launchTo is stored as the IST calendar day at 00:00 UTC; its end is 24:00 IST.
    const endOfLastDay = launchTo.getTime() + 24 * 3600_000 - 5.5 * 3600_000;
    by = Math.min(by, endOfLastDay);
  }
  return new Date(Math.max(by, offeredAt.getTime() + MIN_RESPONSE_MS));
}

// ── Offer (staff approval) ───────────────────────────────────────────────────────────────────

export interface OfferedItem {
  itemId: string;
  creatorId: string;
  accountName: string;
}

/**
 * Inside the approval transaction: every pending creator item of the booking becomes an offer to
 * the page's current owner, with the payout frozen at checkout (the card is a fallback). A page that is no longer
 * bookable (creator suspended, page switched off or disconnected) goes straight to staff instead
 * (`manual_pending` with the reason) — the client has paid for it, so it must be refunded or
 * re-arranged, never left waiting on someone who cannot answer.
 */
export async function offerCreatorItems(tx: Tx, bookingId: string, now = new Date()) {
  const b = await tx.campaignBooking.findUnique({
    where: { id: bookingId },
    select: { launchTo: true, items: { where: { status: "pending", targetType: "creator_asset" }, select: { id: true, targetId: true, rateCardId: true, accountName: true, creatorPayoutPaise: true, audioAddonPaise: true } } },
  });
  const offered: OfferedItem[] = [];
  const toStaff: Array<{ itemId: string; accountName: string; reason: string }> = [];
  if (!b || b.items.length === 0) return { offered, toStaff };
  const [assets, cards] = await Promise.all([
    tx.creatorAsset.findMany({
      where: { id: { in: b.items.map((i) => i.targetId) } },
      select: { id: true, creatorId: true, enabled: true, disconnectedAt: true, creator: { select: { status: true } } },
    }),
    tx.campaignRateCard.findMany({ where: { id: { in: b.items.map((i) => i.rateCardId) } }, select: { id: true, creatorPayoutPaise: true } }),
  ]);
  const assetOf = new Map(assets.map((a) => [a.id, a]));
  const payoutOf = new Map(cards.map((c) => [c.id, c.creatorPayoutPaise]));
  const respondBy = respondByFor(now, b.launchTo);
  for (const item of b.items) {
    const a = assetOf.get(item.targetId);
    const reason = !a || a.disconnectedAt
      ? "The creator's page is no longer connected — refund this post or arrange another page."
      : a.creator.status !== "approved"
        ? "The creator's account is not active — refund this post or arrange another page."
        : !a.enabled
          ? "This creator page was switched off — refund this post or arrange another page."
          : null;
    if (reason || !a) {
      await tx.campaignBookingItem.updateMany({ where: { id: item.id, status: "pending" }, data: { status: "manual_pending", lastError: reason ?? "Unavailable" } });
      toStaff.push({ itemId: item.id, accountName: item.accountName, reason: reason ?? "Unavailable" });
      continue;
    }
    const res = await tx.campaignBookingItem.updateMany({
      where: { id: item.id, status: "pending" },
      data: {
        status: "awaiting_creator",
        creatorId: a.creatorId,
        // Frozen at checkout with the client price; the card is only a fallback for older rows
        // (plus the song add-on, which goes to the creator in full).
        creatorPayoutPaise: item.creatorPayoutPaise ?? (payoutOf.get(item.rateCardId) != null ? payoutOf.get(item.rateCardId)! + item.audioAddonPaise : null),
        creatorOfferedAt: now,
        creatorRespondBy: respondBy,
        creatorDecidedAt: null,
        creatorDeclineReason: null,
        lastError: null,
      },
    });
    if (res.count === 1) offered.push({ itemId: item.id, creatorId: a.creatorId, accountName: item.accountName });
  }
  return { offered, toStaff };
}

/** After the approval commits: one email per creator with new offers. Never throws. */
export async function notifyCreatorsOfOffers(offered: OfferedItem[]) {
  const byCreator = new Map<string, OfferedItem[]>();
  for (const o of offered) byCreator.set(o.creatorId, [...(byCreator.get(o.creatorId) ?? []), o]);
  for (const [creatorId, items] of byCreator) {
    try {
      const c = await prisma.creator.findUnique({ where: { id: creatorId }, select: { email: true, name: true, status: true } });
      if (!c || c.status !== "approved") continue;
      const first = await prisma.campaignBookingItem.findUnique({ where: { id: items[0].itemId }, select: { creatorRespondBy: true } });
      const by = first?.creatorRespondBy ? fmtIst(first.creatorRespondBy) : "soon";
      const pages = [...new Set(items.map((i) => i.accountName))].map((n) => `<li>${esc(n)}</li>`).join("");
      await sendCreatorEmail(
        c.email,
        items.length === 1 ? "A paid post is waiting for you" : `${items.length} paid posts are waiting for you`,
        "New paid post",
        `<p style="margin:0 0 12px">Hi ${esc(c.name)},</p><p style="margin:0 0 12px">A brand booked ${items.length === 1 ? "a post" : `${items.length} posts`} on:</p><ul style="margin:0 0 12px">${pages}</ul><p style="margin:0 0 12px">See the content and your payout, then accept or decline by <b>${esc(by)}</b> (IST). Nothing is posted until you accept.</p><p style="margin:18px 0">${button(creatorLink("/offers"), "Review the post")}</p><p style="margin:12px 0 0">Questions? Reply to this email before you decide — declining is final.</p>`,
        { replyTo: CREATOR_SUPPORT_EMAIL },
      );
    } catch (e) {
      console.warn(`[creator-offers] offer email failed for ${creatorId}: ${scrubSecrets(e instanceof Error ? e.message : String(e))}`);
    }
  }
}

/** A @db.Date column (the IST calendar day at 00:00 UTC) as "13 Nov 2026". */
function fmtIstDay(d: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function fmtIst(d: Date): string {
  const ist = new Date(d.getTime() + 5.5 * 3600_000);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const h = ist.getUTCHours();
  const m = String(ist.getUTCMinutes()).padStart(2, "0");
  return `${ist.getUTCDate()} ${months[ist.getUTCMonth()]} ${ist.getUTCFullYear()}, ${h % 12 || 12}:${m} ${h < 12 ? "am" : "pm"}`;
}

// ── The creator's side ──────────────────────────────────────────────────────────────────────

const OFFER_SELECT = {
  id: true, bookingId: true, status: true, targetType: true, targetId: true, platform: true, format: true,
  accountName: true, accountHandle: true, creatorId: true, creatorPayoutPaise: true, creatorOfferedAt: true,
  creatorRespondBy: true, creatorDecidedAt: true, creatorDeclineReason: true, permalink: true, postedAt: true,
  lastError: true, nextAttemptAt: true, captionOverride: true, hashtagsOverride: true,
  booking: {
    select: {
      id: true, name: true, brand: true, status: true, launchFrom: true, launchTo: true, caption: true, hashtags: true,
      userTags: true, collaborators: true, audioIntegration: true, audioTrack: true, campaignType: true, objective: true,
    },
  },
} as const;
type OfferRow = Prisma.CampaignBookingItemGetPayload<{ select: typeof OFFER_SELECT }>;

const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** What the creator can do with an item right now. */
function actionsFor(o: OfferRow, now: Date) {
  const bookingLive = BOOKING_LIVE.includes(o.booking.status);
  const open = o.status === "awaiting_creator" && bookingLive && (!o.creatorRespondBy || o.creatorRespondBy > now);
  return {
    canAccept: open,
    canDecline: open,
    // An accepted post the API can't publish (song audio, publishing off…): the creator posts it.
    canRecordPost: o.status === "manual_pending" && !!o.creatorDecidedAt && bookingLive,
    // A link the creator recorded can be corrected (a wrong paste) while the campaign is open or
    // settled; the status, the posting time and every email already sent stay as they were.
    canCorrectPost: o.status === "posted_manual" && !!o.creatorDecidedAt && BOOKING_CORRECTABLE.includes(o.booking.status),
  };
}

/**
 * Why the creator posts an accepted booking themselves, in words written for the creator.
 * `last_error` is written for staff ("check with the creator before posting", Meta error codes…),
 * so it is never shown as is: only the content reasons a creator can act on are translated, and
 * anything else becomes null (the portal then shows its own sentence for the auto-posting switch).
 */
const RECONNECT = "We couldn't post through your Facebook connection, so you post this one yourself. Reconnect Facebook on the Pages screen so your pages stay offered to brands.";
const CREATOR_NOTES: Array<[string, string]> = [
  ["Auto-posting on creator pages is switched off", "You post accepted bookings yourself for now."],
  ["Song audio integration", "The brand chose a song, which can only be added in the Instagram app, so you post this one yourself."],
  ["Stories are posted by hand", "Stories can't be posted through our tools, so you post this one yourself."],
  ["Facebook carousels can only hold images", "Facebook only takes photo carousels through our tools, so you post this one yourself."],
  ["The client chose a thumbnail", "The brand chose a cover image, which Facebook only takes in the app, so you post this one yourself with the cover shown below."],
  // We may already have posted it: the creator must look before posting a second copy.
  ["Instagram published the post", "We posted this on your Instagram but couldn't read its link. Find it on your profile and paste its link here — don't post it again."],
  ["Meta didn't confirm the Facebook post", "We may already have posted this on your Page — Facebook didn't confirm it. Check your Page first: if it's there, paste its link instead of posting again."],
  ["Facebook is still processing the reel", "Facebook is still processing the reel we posted. Check your Page: if it's there, paste its link instead of posting again."],
  ["Facebook could not process the reel", "Facebook couldn't process the reel we tried to post, so you post this one yourself."],
  ["The creator's Facebook connection needs reconnecting", RECONNECT],
  ["The creator's Facebook login has expired", RECONNECT],
  ["The creator's stored token could not be read", RECONNECT],
  ["The Meta connection needs reconnecting", RECONNECT],
];
export function creatorNote(lastError: string | null): string | null {
  if (!lastError) return null;
  return CREATOR_NOTES.find(([prefix]) => lastError.startsWith(prefix))?.[1] ?? null;
}

/** The creator-facing shape. Explicit fields only: no client identity, no client price. */
function toOfferView(o: OfferRow, now: Date) {
  const text = itemText(o.booking, o);
  return {
    id: o.id,
    status: o.status,
    platform: o.platform,
    format: o.format,
    formatLabel: formatLabelFor(o.platform as CampaignPlatform, o.format),
    page: { id: o.targetId, name: o.accountName, handle: o.accountHandle },
    campaign: {
      name: o.booking.name,
      brand: o.booking.brand,
      type: o.booking.campaignType,
      launchFrom: ymd(o.booking.launchFrom),
      launchTo: ymd(o.booking.launchTo),
      songTrack: o.booking.audioIntegration ? o.booking.audioTrack : null,
      // What the brand wants from the post, in its own words (never who the brand's client is).
      brief: o.booking.objective?.trim() || null,
    },
    caption: text.caption,
    hashtags: text.hashtags,
    userTags: o.booking.userTags,
    collaborators: o.booking.collaborators,
    payoutPaise: o.creatorPayoutPaise,
    offeredAt: o.creatorOfferedAt,
    respondBy: o.creatorRespondBy,
    decidedAt: o.creatorDecidedAt,
    declineReason: o.creatorDeclineReason,
    // When it goes out (accepted + auto-posting): the worker's next attempt, else the launch time.
    scheduledFor: o.status === "queued" ? o.nextAttemptAt ?? launchAt(o.booking.launchFrom, now) : null,
    permalink: o.permalink,
    postedAt: o.postedAt,
    note: o.status === "manual_pending"
      ? creatorNote(o.lastError)
      : (o.status === "refunded" || o.status === "failed") && o.creatorDeclineReason
        ? "You declined this post — there is nothing to do."
        : o.status === "refunded" && o.creatorDecidedAt == null
        ? "Withdrawn by our team before you answered — there is nothing to do, and no payout for this post."
        : o.status === "refunded"
          ? "Withdrawn by our team — please don't post it. There is no payout for this post."
          : o.status === "failed"
            ? "Our team marked this post as not made. There is no payout for it."
            : null,
    // Whether accepted posts are posted for the creator at all right now (CREATOR_PUBLISH_ENABLED).
    autoPost: campaignConfig.creatorPublishEnabled(),
    ...actionsFor(o, now),
  };
}
export type CreatorOfferView = ReturnType<typeof toOfferView>;

/**
 * The creator's offers. Only items offered to THIS creator (creator_id frozen at the offer);
 * bounded — a creator has at most a few hundred booked posts.
 */
export async function listOffers(creatorId: string, filter: "open" | "all" = "all") {
  const now = new Date();
  const rows = await prisma.campaignBookingItem.findMany({
    where: { creatorId, targetType: "creator_asset", ...(filter === "open" ? { status: "awaiting_creator" } : {}) },
    orderBy: [{ creatorOfferedAt: "desc" }, { id: "asc" }],
    take: 300,
    select: OFFER_SELECT,
  });
  const offers = rows.map((r) => toOfferView(r, now));
  return {
    offers,
    autoPost: campaignConfig.creatorPublishEnabled(),
    counts: {
      waiting: offers.filter((o) => o.canAccept).length,
      toPost: offers.filter((o) => o.canRecordPost).length,
      payoutAcceptedPaise: rows
        .filter((r) => ["queued", "manual_pending", "published", "posted_manual"].includes(r.status) && r.creatorDecidedAt)
        .reduce((s, r) => s + (r.creatorPayoutPaise ?? 0), 0),
    },
  };
}

async function loadOwnOffer(creatorId: string, itemId: string): Promise<OfferRow> {
  const o = await prisma.campaignBookingItem.findFirst({ where: { id: itemId, creatorId, targetType: "creator_asset" }, select: OFFER_SELECT });
  if (!o) throw new AppError(404, "NOT_FOUND", "Post not found");
  return o;
}

/** One offer with signed previews of the exact files that would be posted on this page. */
export async function getOffer(creatorId: string, itemId: string) {
  const o = await loadOwnOffer(creatorId, itemId);
  const files = (await resolveItemFiles(o.bookingId)).get(o.id) ?? [];
  const ttl = 3600;
  return {
    ...toOfferView(o, new Date()),
    files: files.map((f) => ({
      kind: f.kind,
      role: f.role,
      ready: f.status === "done",
      url: signedMediaPath(f.mediaId, f.renderId ? `v-${f.renderId}` : "preview", ttl),
    })),
  };
}

/**
 * The page must still be this creator's, connected and switched on — otherwise the deal cannot be
 * made by them (the item stays with staff).
 */
async function assertStillTheirs(creatorId: string, assetId: string, opts: { alreadyAccepted?: boolean } = {}) {
  const a = await prisma.creatorAsset.findUnique({
    where: { id: assetId },
    select: { creatorId: true, disconnectedAt: true, enabled: true, creator: { select: { status: true } } },
  });
  if (!a || a.creatorId !== creatorId) throw new AppError(409, "PAGE_NOT_YOURS", "This page is no longer linked to your account.");
  if (a.creator.status !== "approved") throw new AppError(403, "ACCOUNT_NOT_ACTIVE", "Your account is not active.");
  // A post the creator already accepted (and posts by hand) does not need a live connection or
  // the staff switch: recording its link must still work after a disconnect or a switch-off.
  if (opts.alreadyAccepted) return;
  if (a.disconnectedAt) throw new AppError(409, "PAGE_DISCONNECTED", "This page is disconnected — reconnect it first.");
  if (!a.enabled) throw new AppError(409, "PAGE_OFF", "Our team switched this page off. Write to creators@digitalsukoon.com.");
}

function assertOpen(o: OfferRow, now: Date) {
  if (o.status !== "awaiting_creator") throw new AppError(409, "ALREADY_DECIDED", "This post has already been answered.");
  if (!BOOKING_LIVE.includes(o.booking.status)) throw new AppError(409, "CAMPAIGN_CLOSED", "This campaign is no longer running.");
  if (o.creatorRespondBy && o.creatorRespondBy <= now) throw new AppError(409, "OFFER_EXPIRED", "The time to answer this post has passed.");
}

/**
 * Accept: the post is scheduled on the creator's page for the launch day (or, when the API
 * cannot post it, handed to the creator to post themselves). One conditional write.
 */
export async function acceptOffer(creatorId: string, itemId: string) {
  const now = new Date();
  const o = await loadOwnOffer(creatorId, itemId);
  assertOpen(o, now);
  await assertStillTheirs(creatorId, o.targetId);

  const booking = await prisma.campaignBooking.findUnique({
    where: { id: o.bookingId },
    select: { launchFrom: true, audioIntegration: true, media: { where: { purgedAt: null }, select: { kind: true, role: true } } },
  });
  const e = await checkEligibility({ targetType: o.targetType, targetId: o.targetId, platform: o.platform, format: o.format, creatorId }, booking ?? { audioIntegration: false, media: [] });
  const data: Prisma.CampaignBookingItemUpdateManyMutationInput = e.ok
    ? { status: "queued", creatorDecidedAt: now, nextAttemptAt: launchAt(booking?.launchFrom ?? null, now), attempts: 0, containerId: null, lastError: null }
    : { status: "manual_pending", creatorDecidedAt: now, nextAttemptAt: null, lastError: e.reason.slice(0, 500) };
  const res = await prisma.campaignBookingItem.updateMany({
    where: { id: itemId, creatorId, status: "awaiting_creator", OR: [{ creatorRespondBy: null }, { creatorRespondBy: { gt: now } }] },
    data,
  });
  if (res.count !== 1) throw new AppError(409, "ALREADY_DECIDED", "This post changed while you were looking — refresh.");
  await logBookingEvent(o.bookingId, creatorActor(creatorId), e.ok
    ? `Creator accepted ${o.accountName} (${o.format}) — scheduled for auto-posting`
    : `Creator accepted ${o.accountName} (${o.format}) — to be posted by hand: ${e.reason}`);
  return getOffer(creatorId, itemId);
}

/** Decline: the post will not go on this page; staff are told so they refund or re-arrange it. */
export async function declineOffer(creatorId: string, itemId: string, reason: string) {
  const now = new Date();
  const o = await loadOwnOffer(creatorId, itemId);
  assertOpen(o, now);
  const res = await prisma.campaignBookingItem.updateMany({
    where: { id: itemId, creatorId, status: "awaiting_creator" },
    data: { status: "creator_declined", creatorDecidedAt: now, creatorDeclineReason: reason.slice(0, 500), lastError: `Declined by the creator: ${reason}`.slice(0, 500) },
  });
  if (res.count !== 1) throw new AppError(409, "ALREADY_DECIDED", "This post changed while you were looking — refresh.");
  await logBookingEvent(o.bookingId, creatorActor(creatorId), `Creator declined ${o.accountName} (${o.format}): ${reason}`);
  void alertStaffDeclined([{ bookingId: o.bookingId, accountName: o.accountName, why: `declined: ${reason}` }]);
  void sendCreatorDeclinedEmail(itemId, "declined").catch((err) => console.error("[creator-offers] client decline email failed", err));
  return getOffer(creatorId, itemId);
}

/**
 * The creator posted an accepted post themselves (the API could not, or publishing is off) and
 * records its link. The link must be on the item's platform; the post then counts as live.
 */
export async function recordCreatorPost(creatorId: string, itemId: string, url: string) {
  const o = await loadOwnOffer(creatorId, itemId);
  if (!isPlatformPostUrl(o.platform as CampaignPlatform, url)) {
    throw new AppError(400, "WRONG_PLATFORM", platformPostLinkError(o.platform as CampaignPlatform));
  }
  // The brand chose when the post may go live; a post recorded before the window opens is not
  // the post they booked (and the client would be emailed "live" on the wrong day).
  const from = ymd(o.booking.launchFrom);
  if (from && from > todayIST()) {
    throw new AppError(409, "BEFORE_WINDOW", `This campaign's posting window opens on ${fmtIstDay(o.booking.launchFrom!)} — post it on or after that day, then paste the link.`);
  }
  const actions = actionsFor(o, new Date());
  if (actions.canCorrectPost) return correctCreatorPost(creatorId, o, url);
  if (!actions.canRecordPost) {
    throw new AppError(409, "INVALID_STATE", o.status === "queued"
      ? "This post is scheduled to go out automatically — no need to post it yourself."
      : "This post can't be marked as posted.");
  }
  await assertStillTheirs(creatorId, o.targetId, { alreadyAccepted: true });
  const res = await prisma.campaignBookingItem.updateMany({
    where: { id: itemId, creatorId, status: "manual_pending", creatorDecidedAt: { not: null } },
    data: { status: "posted_manual", permalink: url, postedAt: new Date(), lastError: null },
  });
  if (res.count !== 1) throw new AppError(409, "INVALID_STATE", "This post changed — refresh.");
  await logBookingEvent(o.bookingId, creatorActor(creatorId), `Creator posted on ${o.accountName} (${o.format}): ${url}`);
  void sendItemLiveEmail(itemId).catch((err) => console.error("[creator-offers] live email failed", err));
  const finished = await settleBooking(o.bookingId, creatorActor(creatorId));
  if (finished) void sendDeliveryEmail(o.bookingId).catch((err) => console.error("[creator-offers] delivery email failed", err));
  return getOffer(creatorId, itemId);
}

/**
 * A wrong link pasted earlier: only the link changes. The post stays live with its original time,
 * no email goes to the client again (they were already told), and staff are told so the client
 * can be sent the right link if needed.
 */
async function correctCreatorPost(creatorId: string, o: OfferRow, url: string) {
  if (url === o.permalink) return getOffer(creatorId, o.id);
  const a = await prisma.creatorAsset.findUnique({ where: { id: o.targetId }, select: { creatorId: true } });
  if (!a || a.creatorId !== creatorId) throw new AppError(409, "PAGE_NOT_YOURS", "This page is no longer linked to your account.");
  const res = await prisma.campaignBookingItem.updateMany({
    where: { id: o.id, creatorId, status: "posted_manual", permalink: o.permalink },
    data: { permalink: url },
  });
  if (res.count !== 1) throw new AppError(409, "INVALID_STATE", "This post changed — refresh.");
  await logBookingEvent(o.bookingId, creatorActor(creatorId), `Creator corrected the link on ${o.accountName} (${o.format}): ${o.permalink ?? "none"} → ${url}`);
  void adminAlert(
    "A creator corrected a post link",
    [
      { label: "Page", value: o.accountName },
      { label: "Old link", value: o.permalink ?? "none" },
      { label: "New link", value: url },
    ],
    `/campaigns/${o.bookingId}`,
  ).catch((err) => console.warn(`[creator-offers] correction alert failed: ${scrubSecrets(err instanceof Error ? err.message : String(err))}`));
  return getOffer(creatorId, o.id);
}

// ── Withdrawn by staff ──────────────────────────────────────────────────────────────────────

/** Item statuses in which a creator has been asked to (or will) put the post on their page. */
export const CREATOR_ENGAGED_STATUSES = ["awaiting_creator", "manual_pending", "queued"];

/**
 * Staff refunded, failed or rejected posts the creator was asked to make: tell each creator once,
 * so nobody posts something that will not be paid. Call it after the change commits, with the
 * items as they were BEFORE it. Never throws.
 */
export async function notifyCreatorsWithdrawn(items: Array<{ id: string; creatorId: string | null; status: string; accountName: string }>) {
  const engaged = items.filter((i) => i.creatorId && CREATOR_ENGAGED_STATUSES.includes(i.status));
  const byCreator = new Map<string, typeof engaged>();
  for (const i of engaged) byCreator.set(i.creatorId!, [...(byCreator.get(i.creatorId!) ?? []), i]);
  for (const [creatorId, rows] of byCreator) {
    try {
      const c = await prisma.creator.findUnique({ where: { id: creatorId }, select: { email: true, name: true, status: true } });
      if (!c || c.status === "closed") continue;
      const pages = [...new Set(rows.map((r) => r.accountName))].map((n) => `<li>${esc(n)}</li>`).join("");
      await sendCreatorEmail(
        c.email,
        rows.length === 1 ? "A booked post was withdrawn" : `${rows.length} booked posts were withdrawn`,
        "Post withdrawn",
        `<p style="margin:0 0 12px">Hi ${esc(c.name)},</p><p style="margin:0 0 12px">Our team withdrew ${rows.length === 1 ? "a booked post" : "booked posts"} on:</p><ul style="margin:0 0 12px">${pages}</ul><p style="margin:0 0 12px"><b>Please don't post ${rows.length === 1 ? "it" : "them"}.</b> There is no payout for a withdrawn post. If you have already posted, reply to this email and tell us.</p><p style="margin:18px 0">${button(creatorLink("/offers"), "See your bookings")}</p>`,
        { replyTo: CREATOR_SUPPORT_EMAIL },
      );
    } catch (e) {
      console.warn(`[creator-offers] withdrawal email failed for ${creatorId}: ${scrubSecrets(e instanceof Error ? e.message : String(e))}`);
    }
  }
}

// ── Reminder before the answer deadline ─────────────────────────────────────────────────────

const reminderTag = (itemId: string) => `[reminded:${itemId}]`;

/**
 * About a day before `creator_respond_by`, remind the creator once. The booking event is the
 * record that it was sent (no column needed); the job's overlap guard keeps two runs apart.
 * Offers that gave less than REMIND_MIN_WINDOW_MS in total get no reminder.
 */
export async function remindCreatorOffers(now = new Date()): Promise<number> {
  const due = await prisma.campaignBookingItem.findMany({
    where: {
      status: "awaiting_creator",
      creatorId: { not: null },
      creatorRespondBy: { gt: now, lte: new Date(now.getTime() + REMIND_BEFORE_MS) },
      booking: { status: { in: BOOKING_LIVE } },
    },
    orderBy: { creatorRespondBy: "asc" },
    take: EXPIRE_BATCH,
    select: { id: true, bookingId: true, creatorId: true, accountName: true, format: true, creatorOfferedAt: true, creatorRespondBy: true },
  });
  let sent = 0;
  for (const d of due) {
    if (!d.creatorOfferedAt || !d.creatorRespondBy) continue;
    if (d.creatorRespondBy.getTime() - d.creatorOfferedAt.getTime() <= REMIND_MIN_WINDOW_MS) continue;
    const already = await prisma.campaignBookingEvent.findFirst({ where: { bookingId: d.bookingId, note: { contains: reminderTag(d.id) } }, select: { id: true } });
    if (already) continue;
    // Record first: a failed send is not retried (one reminder, never a stream of them).
    await logBookingEvent(d.bookingId, SYSTEM, `Reminded the creator to answer for ${d.accountName} (${d.format}) ${reminderTag(d.id)}`);
    try {
      const c = await prisma.creator.findUnique({ where: { id: d.creatorId! }, select: { email: true, name: true, status: true } });
      if (!c || c.status !== "approved") continue;
      await sendCreatorEmail(
        c.email,
        `Answer by ${fmtIst(d.creatorRespondBy)} — a paid post is waiting`,
        "A paid post is waiting for your answer",
        `<p style="margin:0 0 12px">Hi ${esc(c.name)},</p><p style="margin:0 0 12px">A booked post on <b>${esc(d.accountName)}</b> is still waiting for your answer. Accept or decline by <b>${esc(fmtIst(d.creatorRespondBy))}</b> (IST) — after that it is treated as declined.</p><p style="margin:18px 0">${button(creatorLink(`/offers/view?id=${d.id}`), "Review the post")}</p><p style="margin:12px 0 0">Questions? Reply to this email.</p>`,
        { replyTo: CREATOR_SUPPORT_EMAIL },
      );
      sent++;
    } catch (e) {
      console.warn(`[creator-offers] reminder failed for ${d.id}: ${scrubSecrets(e instanceof Error ? e.message : String(e))}`);
    }
  }
  return sent;
}

// ── Expiry + staff alerts ───────────────────────────────────────────────────────────────────

/**
 * No answer by `creator_respond_by` = declined. Bounded per run; each row moves with a
 * conditional write so a last-second accept wins cleanly. Returns how many expired.
 */
export async function expireCreatorOffers(now = new Date()): Promise<number> {
  const due = await prisma.campaignBookingItem.findMany({
    where: { status: "awaiting_creator", creatorRespondBy: { lte: now } },
    orderBy: { creatorRespondBy: "asc" },
    take: EXPIRE_BATCH,
    select: { id: true, bookingId: true, accountName: true, format: true },
  });
  const expired: Array<{ bookingId: string; accountName: string; why: string }> = [];
  for (const d of due) {
    const res = await prisma.campaignBookingItem.updateMany({
      where: { id: d.id, status: "awaiting_creator", creatorRespondBy: { lte: now } },
      data: { status: "creator_declined", creatorDecidedAt: now, creatorDeclineReason: "No answer in time", lastError: "The creator did not answer in time." },
    });
    if (res.count !== 1) continue;
    await logBookingEvent(d.bookingId, SYSTEM, `Creator did not answer in time for ${d.accountName} (${d.format})`);
    expired.push({ bookingId: d.bookingId, accountName: d.accountName, why: "no answer in time" });
    await sendCreatorDeclinedEmail(d.id, "expired").catch((err) => console.error("[creator-offers] client expiry email failed", err));
  }
  if (expired.length) await alertStaffDeclined(expired);
  return expired.length;
}

/** Tell the admin inbox; the campaign page shows the item with Refund / drop. Never throws. */
async function alertStaffDeclined(rows: Array<{ bookingId: string; accountName: string; why: string }>) {
  try {
    await adminAlert(
      rows.length === 1 ? "A creator post needs a refund or another page" : `${rows.length} creator posts need a refund or another page`,
      rows.map((r) => ({ label: r.accountName, value: r.why })),
      rows.length === 1 ? `/campaigns/${rows[0].bookingId}` : "/campaigns",
    );
  } catch (e) {
    console.warn(`[creator-offers] staff alert failed: ${scrubSecrets(e instanceof Error ? e.message : String(e))}`);
  }
}

let expiring = false;

/** Cron entry: overlap guard claimed before the first await. Never throws. */
export async function runCreatorOfferExpiry(): Promise<number> {
  if (expiring) return 0;
  expiring = true;
  try {
    await remindCreatorOffers().catch((err) => console.error("[creator-offers] reminders failed:", err));
    return await expireCreatorOffers();
  } catch (err) {
    console.error("[creator-offers] expiry failed:", err);
    return 0;
  } finally {
    expiring = false;
  }
}

