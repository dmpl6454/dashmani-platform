import { prisma, Prisma } from "@dashmani/db";
import {
  CAMPAIGN_LIMITS,
  EDITABLE_BOOKING_STATUSES,
  PLATFORM_FORMATS,
  SETTLED_ITEM_STATUSES,
  LIVE_ITEM_STATUSES,
  type BookingStatus,
  type CampaignCreativeInput,
  type CampaignInfoInput,
  type CampaignItemOverridesInput,
  type CampaignPlatform,
  type CampaignFormat,
} from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { razorpayConfig } from "./config";
import { durationLimitSec } from "./media.service";
import { overlayKey } from "./render.service";
import { priceFor, resolveCatalogueTargets } from "./rate-card.service";

// Campaign bookings — the client's side of the lifecycle and the one state-transition helper
// every other module goes through.
//
//   draft → awaiting_payment → paid_pending_review ⇄ changes_requested → approved
//         → publishing → completed | partially_published
//   side exits: rejected → refunded, cancelled, expired
//
// ⚠️ Every status change goes through transitionBooking(): an UPDATE … WHERE status IN (from)
// that must touch exactly one row. Two racing actors (a webhook and a staff click, two tabs)
// cannot both win — the loser gets a 409 instead of silently overwriting.

export type Actor = { type: "client" | "staff" | "system"; id?: string | null };

type Tx = Prisma.TransactionClient;

/**
 * Serialise every client edit of ONE booking. Items, creative and per-account text edits each
 * read-then-rewrite the booking's items and render variants; two overlapping edits (two tabs,
 * a double click) would otherwise delete each other's variant rows or hit the unique key. The
 * row lock is taken first in every such transaction, so there is one lock order.
 */
async function lockBooking(tx: Tx, bookingId: string) {
  await tx.$queryRaw`SELECT id FROM campaign_bookings WHERE id = ${bookingId} FOR UPDATE`;
}

export async function transitionBooking(
  bookingId: string,
  from: readonly BookingStatus[],
  to: BookingStatus,
  actor: Actor,
  opts: { note?: string | null; data?: Prisma.CampaignBookingUpdateManyMutationInput; tx?: Tx } = {},
): Promise<BookingStatus> {
  const run = async (tx: Tx) => {
    const current = await tx.campaignBooking.findUnique({ where: { id: bookingId }, select: { status: true } });
    if (!current) throw new AppError(404, "NOT_FOUND", "Campaign not found");
    const res = await tx.campaignBooking.updateMany({
      where: { id: bookingId, status: { in: [...from] } },
      data: { ...(opts.data ?? {}), status: to },
    });
    if (res.count !== 1) {
      throw new AppError(409, "INVALID_STATE", `This campaign can't move from "${current.status}" to "${to}" right now. Refresh and try again.`);
    }
    await tx.campaignBookingEvent.create({
      data: { bookingId, actorType: actor.type, actorId: actor.id ?? null, fromStatus: current.status, toStatus: to, note: opts.note ?? null },
    });
    return current.status as BookingStatus;
  };
  return opts.tx ? run(opts.tx) : prisma.$transaction(run);
}

export async function logBookingEvent(bookingId: string, actor: Actor, note: string, tx: Tx | typeof prisma = prisma) {
  await tx.campaignBookingEvent.create({ data: { bookingId, actorType: actor.type, actorId: actor.id ?? null, note } });
}

// ── Reads ───────────────────────────────────────────────────────────────────────

const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

const mediaSelect = {
  id: true,
  position: true,
  kind: true,
  role: true,
  originalName: true,
  mime: true,
  bytes: true,
  durationMs: true,
  width: true,
  height: true,
  uploadStatus: true,
  rejectReason: true,
  renderStatus: true,
  renderError: true,
  purgedAt: true,
} satisfies Prisma.CampaignMediaSelect;

const itemSelect = {
  id: true,
  rateCardId: true,
  platform: true,
  format: true,
  accountName: true,
  accountHandle: true,
  pricePaise: true,
  audioAddonPaise: true,
  captionOverride: true,
  hashtagsOverride: true,
  superTextOverride: true,
  superTextStyleOverride: true,
  status: true,
  permalink: true,
  postedAt: true,
  lastError: true,
} satisfies Prisma.CampaignBookingItemSelect;

/**
 * The overlay an item actually carries: its own override when set ("" = none), else the
 * booking's. Returned as the text + style the renderer uses, so callers compare keys, never
 * strings.
 */
export function itemOverlay(
  b: { format: string | null; superText: string | null; superTextStyle: string | null },
  item: { superTextOverride: string | null; superTextStyleOverride: string | null },
): { text: string | null; style: string | null; key: string; custom: boolean } {
  const format = b.format ?? "post";
  const defaultKey = overlayKey(format, b.superText, b.superTextStyle);
  if (item.superTextOverride == null) return { text: b.superText, style: b.superTextStyle, key: defaultKey, custom: false };
  const text = item.superTextOverride.trim() || null;
  const style = text ? item.superTextStyleOverride ?? "bottom" : null;
  const key = overlayKey(format, text, style);
  return { text, style, key, custom: key !== defaultKey };
}

/** The caption + hashtags an item posts with: its own when it has a caption override, else the booking's. */
export function itemText(
  b: { caption: string | null; hashtags: string[] },
  item: { captionOverride: string | null; hashtagsOverride: string[] },
): { caption: string; hashtags: string[]; custom: boolean } {
  if (item.captionOverride == null) return { caption: b.caption ?? "", hashtags: b.hashtags, custom: false };
  return { caption: item.captionOverride, hashtags: item.hashtagsOverride, custom: true };
}

/**
 * Per item, the file to post for each creative (and the thumbnail): the per-account render
 * when the item customised its overlay, else the default render on the media row. `status`
 * is the render's state so callers can wait for it; `renderId` names the variant for a signed
 * "v-<id>" URL (null = the media's own preview).
 */
export async function resolveItemFiles(bookingId: string) {
  const b = await prisma.campaignBooking.findUnique({
    where: { id: bookingId },
    select: {
      format: true, superText: true, superTextStyle: true,
      media: { where: { purgedAt: null, uploadStatus: "complete" }, orderBy: [{ role: "asc" }, { position: "asc" }], select: { id: true, kind: true, role: true, renderStatus: true } },
      renders: { select: { id: true, mediaId: true, overlayKey: true, status: true } },
      items: { select: { id: true, superTextOverride: true, superTextStyleOverride: true } },
    },
  });
  const out = new Map<string, Array<{ mediaId: string; kind: string; role: string; custom: boolean; renderId: string | null; status: string }>>();
  if (!b) return out;
  for (const item of b.items) {
    const ov = itemOverlay(b, item);
    out.set(
      item.id,
      b.media.map((m) => {
        if (!ov.custom) return { mediaId: m.id, kind: m.kind, role: m.role, custom: false, renderId: null, status: m.renderStatus };
        const v = b.renders.find((r) => r.mediaId === m.id && r.overlayKey === ov.key);
        return { mediaId: m.id, kind: m.kind, role: m.role, custom: true, renderId: v?.id ?? null, status: v?.status ?? "queued" };
      }),
    );
  }
  return out;
}

/** One status for an item's own renders: failed > queued/rendering > done; null when the item uses the default files. */
function summariseRenders(files: Array<{ custom: boolean; status: string }>): string | null {
  if (!files.some((f) => f.custom)) return null;
  if (files.some((f) => f.status === "failed")) return "failed";
  if (files.some((f) => f.status !== "done")) return "queued";
  return "done";
}

function shapeBooking(b: any, files?: Awaited<ReturnType<typeof resolveItemFiles>>) {
  const media = (b.media ?? []).map((m: any) => ({ ...m, bytes: Number(m.bytes) }));
  return {
    id: b.id,
    name: b.name,
    brand: b.brand,
    objective: b.objective,
    launchFrom: ymd(b.launchFrom),
    launchTo: ymd(b.launchTo),
    format: b.format,
    campaignType: b.campaignType,
    audioIntegration: b.audioIntegration,
    audioTrack: b.audioTrack,
    caption: b.caption,
    hashtags: b.hashtags,
    userTags: b.userTags,
    collaborators: b.collaborators,
    superText: b.superText,
    superTextStyle: b.superTextStyle,
    status: b.status,
    totalPaise: b.totalPaise,
    reviewNote: b.reviewNote,
    submittedAt: b.submittedAt,
    paidAt: b.paidAt,
    // "razorpay" → the Pay step opens the gateway; "offline" → it submits for review and the
    // amount is collected by hand (the state while the gateway is deferred).
    paymentMode: razorpayConfig.paymentMode(),
    approvedAt: b.approvedAt,
    deliveredAt: b.deliveredAt,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    media: media.filter((m: any) => m.role !== "thumbnail"),
    thumbnail: media.find((m: any) => m.role === "thumbnail") ?? null,
    items: (b.items ?? []).map((i: any) => ({ ...i, renderStatus: files ? summariseRenders(files.get(i.id) ?? []) : null })),
  };
}

export async function listClientBookings(clientId: string) {
  const rows = await prisma.campaignBooking.findMany({
    where: { clientId },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      name: true,
      brand: true,
      status: true,
      format: true,
      campaignType: true,
      totalPaise: true,
      launchFrom: true,
      launchTo: true,
      createdAt: true,
      updatedAt: true,
      items: { select: { status: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    brand: r.brand,
    status: r.status,
    format: r.format,
    campaignType: r.campaignType,
    totalPaise: r.totalPaise,
    launchFrom: ymd(r.launchFrom),
    launchTo: ymd(r.launchTo),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    itemCount: r.items.length,
    liveCount: r.items.filter((i) => (LIVE_ITEM_STATUSES as readonly string[]).includes(i.status)).length,
  }));
}

/** Client view. ⚠️ Scoped by clientId — another client's booking is a 404, never a 403. */
export async function getClientBooking(clientId: string, id: string) {
  const b = await prisma.campaignBooking.findFirst({
    where: { id, clientId },
    include: {
      media: { where: { purgedAt: null }, orderBy: { position: "asc" }, select: mediaSelect },
      items: { orderBy: [{ createdAt: "asc" }, { accountName: "asc" }, { id: "asc" }], select: itemSelect },
    },
  });
  if (!b) throw new AppError(404, "NOT_FOUND", "Campaign not found");
  return shapeBooking(b, await resolveItemFiles(b.id));
}

async function requireEditable(clientId: string, id: string, allowed: readonly BookingStatus[] = EDITABLE_BOOKING_STATUSES) {
  const b = await prisma.campaignBooking.findFirst({ where: { id, clientId }, select: { id: true, status: true } });
  if (!b) throw new AppError(404, "NOT_FOUND", "Campaign not found");
  if (!allowed.includes(b.status as BookingStatus)) {
    throw new AppError(409, "NOT_EDITABLE", "This campaign can no longer be edited.");
  }
  return b;
}

// ── Writes (client) ─────────────────────────────────────────────────────────────

const dateOf = (s: string) => new Date(`${s}T00:00:00.000Z`);

export async function createBooking(clientId: string, info: CampaignInfoInput) {
  const b = await prisma.$transaction(async (tx) => {
    const created = await tx.campaignBooking.create({
      data: {
        clientId,
        name: info.name,
        brand: info.brand,
        objective: info.objective ?? null,
        campaignType: info.campaignType ?? "brand",
        launchFrom: dateOf(info.launchFrom),
        launchTo: dateOf(info.launchTo),
      },
      select: { id: true },
    });
    await tx.campaignBookingEvent.create({
      data: { bookingId: created.id, actorType: "client", actorId: clientId, toStatus: "draft", note: "Campaign created" },
    });
    return created;
  });
  return getClientBooking(clientId, b.id);
}

/**
 * Any edit after checkout invalidates the order the client was about to pay: prices and
 * creative are frozen at checkout. Dropping back to draft forces a fresh checkout, and the
 * webhook refuses (and refunds) a payment whose amount no longer matches the booking.
 */
async function resetCheckoutIfNeeded(tx: Tx, bookingId: string, status: string, clientId: string) {
  if (status !== "awaiting_payment") return;
  await transitionBooking(bookingId, ["awaiting_payment"], "draft", { type: "client", id: clientId }, {
    tx,
    note: "Edited after checkout — checkout must be repeated",
    data: { totalPaise: null, pricingSnapshot: Prisma.DbNull },
  });
}

export async function updateInfo(clientId: string, id: string, info: CampaignInfoInput) {
  const b = await requireEditable(clientId, id, ["draft", "awaiting_payment"]);
  await prisma.$transaction(async (tx) => {
    await lockBooking(tx, id);
    await tx.campaignBooking.update({
      where: { id },
      data: {
        name: info.name,
        brand: info.brand,
        objective: info.objective ?? null,
        campaignType: info.campaignType ?? "brand",
        launchFrom: dateOf(info.launchFrom),
        launchTo: dateOf(info.launchTo),
      },
    });
    // repriceItems can DROP items; their custom overlays' renders must go with them.
    await repriceItems(tx, id);
    await syncRenderVariants(tx, id);
    await resetCheckoutIfNeeded(tx, id, b.status, clientId);
  });
  return getClientBooking(clientId, id);
}

/**
 * Save the creative: format, media (ordered), caption, tags, overlay text. Media must be this
 * client's completed uploads that are not attached to another booking. Rendering (re)starts
 * for every attached file, because the overlay may have changed.
 */
export async function updateCreative(clientId: string, id: string, c: CampaignCreativeInput) {
  const b = await requireEditable(clientId, id);
  if (b.status === "changes_requested") {
    // Already paid: the format and the audio option decide which accounts were booked and
    // what they cost, so they are frozen. Only the creative itself may change.
    const cur = await prisma.campaignBooking.findUnique({ where: { id }, select: { format: true, audioIntegration: true } });
    if (cur && (cur.format !== c.format || cur.audioIntegration !== (c.format === "reel" && !!c.audioIntegration))) {
      throw new AppError(409, "PAID_TERMS_FROZEN", "The format and song audio option can't change after payment. Contact us if you need to change them.");
    }
  }

  const thumbId = c.thumbnailMediaId ?? null;
  const wantedIds = thumbId ? [...c.mediaIds, thumbId] : c.mediaIds;
  const media = await prisma.campaignMedia.findMany({
    where: { id: { in: wantedIds }, clientId, purgedAt: null },
    select: { id: true, kind: true, uploadStatus: true, bookingId: true, durationMs: true },
  });
  if (media.length !== new Set(wantedIds).size) throw new AppError(400, "MEDIA_NOT_FOUND", "One of the files could not be found. Upload it again.");
  for (const m of media) {
    if (m.uploadStatus !== "complete") throw new AppError(400, "MEDIA_NOT_READY", "Wait for every upload to finish first.");
    if (m.bookingId && m.bookingId !== id) throw new AppError(400, "MEDIA_IN_USE", "A file is already used by another campaign. Upload it again.");
  }
  const creative = media.filter((m) => m.id !== thumbId);
  const thumb = thumbId ? media.find((m) => m.id === thumbId) : null;
  const kinds = new Set(creative.map((m) => m.kind));
  if (c.format !== "carousel" && c.format !== "story" && c.format !== "post" && kinds.has("image")) {
    throw new AppError(400, "FORMAT_MISMATCH", "A reel needs a video.");
  }
  if (thumb) {
    if (thumb.kind !== "image") throw new AppError(400, "THUMBNAIL_NOT_IMAGE", "The thumbnail must be a JPG or PNG image.");
    if (!kinds.has("video")) throw new AppError(400, "THUMBNAIL_NEEDS_VIDEO", "A thumbnail applies to a video. Remove it for an image post.");
  }
  for (const m of creative) {
    const limit = durationLimitSec(c.format, m.kind);
    if (limit && m.durationMs != null && m.durationMs > limit * 1000) {
      throw new AppError(400, "TOO_LONG", `Videos for a ${c.format} can be at most ${limit} seconds.`);
    }
  }

  await prisma.$transaction(async (tx) => {
    await lockBooking(tx, id);
    // Detach files that are no longer part of the creative (they stay with the client and
    // are purged by retention if never reused).
    await tx.campaignMedia.updateMany({
      where: { bookingId: id, id: { notIn: wantedIds } },
      data: { bookingId: null, role: "creative", renderStatus: "none", renderKey: null },
    });
    for (const [position, mediaId] of c.mediaIds.entries()) {
      await tx.campaignMedia.update({
        where: { id: mediaId },
        data: { bookingId: id, position, role: "creative", renderStatus: "queued", renderKey: null, renderError: null, renderLockedUntil: null },
      });
    }
    if (thumbId) {
      // The thumbnail is rendered like the creative (same format, same overlay) so the cover
      // matches the post. It never counts as a carousel slide: role keeps it apart.
      await tx.campaignMedia.update({
        where: { id: thumbId },
        data: { bookingId: id, position: 0, role: "thumbnail", renderStatus: "queued", renderKey: null, renderError: null, renderLockedUntil: null },
      });
    }
    await tx.campaignBooking.update({
      where: { id },
      data: {
        format: c.format,
        caption: c.caption ?? "",
        hashtags: c.hashtags ?? [],
        userTags: c.userTags ?? [],
        collaborators: c.collaborators ?? [],
        superText: c.superText?.trim() ? c.superText.trim() : null,
        superTextStyle: c.superText?.trim() ? c.superTextStyle ?? "bottom" : null,
        audioIntegration: c.format === "reel" && !!c.audioIntegration,
        audioTrack: c.format === "reel" && c.audioIntegration && c.audioTrack?.trim() ? c.audioTrack.trim() : null,
      },
    });
    // Format changed → booked items for formats the new one doesn't match are dropped.
    await tx.campaignBookingItem.deleteMany({ where: { bookingId: id, format: { not: c.format } } });
    // Audio integration toggled → prices change (and accounts without an audio price drop out).
    // Never after payment: paid item prices stay what was paid.
    if (b.status !== "changes_requested") await repriceItems(tx, id);
    await syncRenderVariants(tx, id);
    await resetCheckoutIfNeeded(tx, id, b.status, clientId);
  });
  return getClientBooking(clientId, id);
}

/**
 * Per-account text: this account's own caption / hashtags / overlay, or back to the
 * booking's. An overlay that differs from the booking's queues its own render of every file
 * (the preview and the checkout gate cover it like the default render).
 */
export async function updateItemOverrides(clientId: string, id: string, itemId: string, o: CampaignItemOverridesInput) {
  const b = await requireEditable(clientId, id);
  const item = await prisma.campaignBookingItem.findFirst({ where: { id: itemId, bookingId: id }, select: { id: true } });
  if (!item) throw new AppError(404, "NOT_FOUND", "Account not found on this campaign");
  await prisma.$transaction(async (tx) => {
    await lockBooking(tx, id);
    await tx.campaignBookingItem.update({
      where: { id: itemId },
      data: {
        captionOverride: o.caption,
        hashtagsOverride: o.caption == null ? [] : o.hashtags ?? [],
        // "" is kept as-is: it means "no overlay on this account" (null = the booking's overlay).
        superTextOverride: o.superText == null ? null : o.superText.trim(),
        superTextStyleOverride: o.superText?.trim() ? o.superTextStyle ?? "bottom" : null,
      },
    });
    await syncRenderVariants(tx, id);
    await resetCheckoutIfNeeded(tx, id, b.status, clientId);
  });
  return getClientBooking(clientId, id);
}

/**
 * Make campaign_media_renders match what the items ask for: one row per (file, overlay) for
 * every item whose overlay differs from the booking's, nothing else. New rows start queued;
 * rows nobody needs any more are deleted (retention removes their files once unreferenced).
 */
export async function syncRenderVariants(tx: Tx, bookingId: string) {
  const b = await tx.campaignBooking.findUnique({
    where: { id: bookingId },
    select: {
      format: true, superText: true, superTextStyle: true,
      media: { where: { purgedAt: null, uploadStatus: "complete" }, select: { id: true } },
      items: { select: { superTextOverride: true, superTextStyleOverride: true } },
      renders: { select: { id: true, mediaId: true, overlayKey: true, status: true } },
    },
  });
  if (!b) return;
  const wanted = new Map<string, { text: string | null; style: string | null }>();
  for (const item of b.items) {
    const ov = itemOverlay(b, item);
    if (ov.custom) wanted.set(ov.key, { text: ov.text, style: ov.style });
  }
  // Every distinct custom overlay is one more render of every file — bound it so a booking
  // cannot queue an unbounded amount of ffmpeg work and disk.
  if (wanted.size > CAMPAIGN_LIMITS.customOverlaysMax) {
    throw new AppError(400, "TOO_MANY_OVERLAYS", `A campaign can carry at most ${CAMPAIGN_LIMITS.customOverlaysMax} different super texts across its accounts. Reuse the same text on several accounts.`);
  }
  const keep = new Set<string>();
  for (const m of b.media) {
    for (const [key, ov] of wanted) {
      const existing = b.renders.find((r) => r.mediaId === m.id && r.overlayKey === key);
      if (existing) {
        keep.add(existing.id);
        // A failed render is retried by any later edit, exactly like the default render is.
        if (existing.status === "failed") {
          await tx.campaignMediaRender.update({ where: { id: existing.id }, data: { status: "queued", error: null, lockedUntil: null } });
        }
      } else {
        const created = await tx.campaignMediaRender.create({
          data: { mediaId: m.id, bookingId, overlayKey: key, overlayText: ov.text, overlayStyle: ov.style, status: "queued" },
          select: { id: true },
        });
        keep.add(created.id);
      }
    }
  }
  await tx.campaignMediaRender.deleteMany({ where: { bookingId, id: { notIn: [...keep] } } });
}

/**
 * Pick the accounts. The client sends rate-card ids ONLY — never prices; every price is read
 * from the rate card here and frozen on the item.
 */
export async function updateItems(clientId: string, id: string, rateCardIds: string[]) {
  const b = await requireEditable(clientId, id, ["draft", "awaiting_payment"]);
  const booking = await prisma.campaignBooking.findUnique({
    where: { id },
    select: { format: true, campaignType: true, audioIntegration: true },
  });
  if (!booking?.format) throw new AppError(400, "NO_FORMAT", "Add your creative before choosing accounts.");

  const cards = await prisma.campaignRateCard.findMany({ where: { id: { in: rateCardIds }, active: true } });
  if (cards.length !== new Set(rateCardIds).size) {
    throw new AppError(400, "RATE_CARD_UNAVAILABLE", "One of the accounts is no longer available. Refresh the list.");
  }
  const prices = new Map<string, { addon: number; total: number }>();
  for (const c of cards) {
    if (c.format !== booking.format) throw new AppError(400, "FORMAT_MISMATCH", "Every account must be booked for the campaign's format.");
    const p = priceFor(c, booking);
    if (!p) {
      throw new AppError(
        400,
        "RATE_CARD_UNAVAILABLE",
        booking.audioIntegration
          ? "One of the accounts doesn't offer song audio integration for this campaign type. Refresh the list."
          : "One of the accounts isn't offered for this campaign type. Refresh the list.",
      );
    }
    prices.set(c.id, p);
  }
  const targets = await resolveCatalogueTargets(cards.map((c) => ({ targetType: c.targetType, targetId: c.targetId })));
  for (const c of cards) {
    if (!targets.has(`${c.targetType}:${c.targetId}`)) {
      throw new AppError(400, "RATE_CARD_UNAVAILABLE", "One of the accounts is no longer available. Refresh the list.");
    }
  }

  await prisma.$transaction(async (tx) => {
    await lockBooking(tx, id);
    // Accounts kept across the edit keep their own caption / overlay.
    const previous = await tx.campaignBookingItem.findMany({
      where: { bookingId: id },
      select: { rateCardId: true, captionOverride: true, hashtagsOverride: true, superTextOverride: true, superTextStyleOverride: true },
    });
    const kept = new Map(previous.map((p) => [p.rateCardId, p]));
    await tx.campaignBookingItem.deleteMany({ where: { bookingId: id } });
    await tx.campaignBookingItem.createMany({
      data: cards.map((c) => {
        const t = targets.get(`${c.targetType}:${c.targetId}`)!;
        const p = kept.get(c.id);
        return {
          bookingId: id,
          rateCardId: c.id,
          targetType: c.targetType,
          targetId: c.targetId,
          platform: c.platform,
          format: c.format,
          accountName: t.name.slice(0, 200),
          accountHandle: t.username?.slice(0, 100) ?? null,
          pricePaise: prices.get(c.id)!.total,
          audioAddonPaise: prices.get(c.id)!.addon,
          captionOverride: p?.captionOverride ?? null,
          hashtagsOverride: p?.hashtagsOverride ?? [],
          superTextOverride: p?.superTextOverride ?? null,
          superTextStyleOverride: p?.superTextStyleOverride ?? null,
        };
      }),
    });
    await syncRenderVariants(tx, id);
    await resetCheckoutIfNeeded(tx, id, b.status, clientId);
  });
  return getClientBooking(clientId, id);
}

/**
 * Re-price every booked item from the current rate card after the campaign type or the audio
 * option changed. Items whose account no longer offers what the booking asks for are dropped
 * (the client sees them disappear from the account list and can pick others).
 */
async function repriceItems(tx: Tx, bookingId: string) {
  const booking = await tx.campaignBooking.findUnique({
    where: { id: bookingId },
    select: { format: true, campaignType: true, audioIntegration: true, items: { select: { id: true, rateCardId: true } } },
  });
  if (!booking || booking.items.length === 0) return;
  const cards = await tx.campaignRateCard.findMany({
    where: { id: { in: booking.items.map((i) => i.rateCardId) }, active: true },
  });
  const byId = new Map(cards.map((c) => [c.id, c]));
  for (const item of booking.items) {
    const card = byId.get(item.rateCardId);
    const p = card ? priceFor(card, booking) : null;
    if (!p) await tx.campaignBookingItem.delete({ where: { id: item.id } });
    else await tx.campaignBookingItem.update({ where: { id: item.id }, data: { pricePaise: p.total, audioAddonPaise: p.addon } });
  }
}

export async function cancelBooking(clientId: string, id: string) {
  await requireEditable(clientId, id, ["draft", "awaiting_payment"]);
  await transitionBooking(id, ["draft", "awaiting_payment"], "cancelled", { type: "client", id: clientId });
  return getClientBooking(clientId, id);
}

/** Client re-submits after "changes requested". Only the creative may have changed. */
export async function submitChanges(clientId: string, id: string) {
  await requireEditable(clientId, id, ["changes_requested"]);
  await assertCreativeReady(id);
  await transitionBooking(id, ["changes_requested"], "paid_pending_review", { type: "client", id: clientId }, {
    note: "Changes submitted",
    data: { submittedAt: new Date() },
  });
  return getClientBooking(clientId, id);
}

/** Everything a checkout (or re-submission) needs: creative saved, every render finished. */
export async function assertCreativeReady(id: string) {
  const b = await prisma.campaignBooking.findUnique({
    where: { id },
    select: {
      format: true,
      media: { where: { purgedAt: null }, select: { role: true, renderStatus: true, uploadStatus: true } },
      // Only renders of files still attached to this booking: a variant of a purged or detached
      // file is never rendered and must not hold checkout hostage.
      renders: { where: { media: { purgedAt: null, bookingId: id } }, select: { status: true } },
    },
  });
  if (!b?.format || b.media.filter((m) => m.role !== "thumbnail").length === 0) throw new AppError(400, "NO_CREATIVE", "Add your creative first.");
  const states = [...b.media.map((m) => m.renderStatus), ...b.renders.map((r) => r.status)];
  if (states.some((s) => s === "failed")) {
    throw new AppError(400, "RENDER_FAILED", "We couldn't prepare one of your files. Upload it again or contact us.");
  }
  if (states.some((s) => s !== "done")) {
    throw new AppError(409, "RENDER_PENDING", "We're still preparing your preview. Try again in a minute.");
  }
}

/**
 * Whether a format can go on a platform at all. Rate cards are validated against this on
 * upsert, so a booking can never contain e.g. a YouTube story.
 */
export function platformCarriesFormat(platform: string, format: string): boolean {
  return (PLATFORM_FORMATS[platform as CampaignPlatform] ?? []).includes(format as CampaignFormat);
}

// ── Settlement (shared by review + publish paths) ───────────────────────────────

/**
 * After an item changes state, move the booking on: approved → publishing on the first live
 * post; publishing → completed / partially_published once every item has settled. Returns
 * true when the booking has just finished (the caller sends the delivery email).
 */
export async function settleBooking(bookingId: string, actor: Actor): Promise<boolean> {
  const b = await prisma.campaignBooking.findUnique({
    where: { id: bookingId },
    select: { status: true, items: { select: { status: true } } },
  });
  if (!b || !["approved", "publishing"].includes(b.status)) return false;
  const statuses = b.items.map((i) => i.status);
  const live = statuses.filter((s) => (LIVE_ITEM_STATUSES as readonly string[]).includes(s)).length;
  const settled = statuses.every((s) => (SETTLED_ITEM_STATUSES as readonly string[]).includes(s));
  try {
    if (settled && statuses.length > 0) {
      const to: BookingStatus = live === statuses.length ? "completed" : "partially_published";
      await transitionBooking(bookingId, ["approved", "publishing"], to, actor);
      return true;
    }
    if (live > 0 && b.status === "approved") {
      await transitionBooking(bookingId, ["approved"], "publishing", actor);
    }
  } catch (err) {
    // A concurrent settle already moved it — not an error for this caller.
    if (err instanceof AppError && err.statusCode === 409) return false;
    throw err;
  }
  return false;
}
