import { prisma, type Prisma } from "@dashmani/db";
import {
  CREATOR_PRICED_FORMATS,
  creatorClientPricePaise,
  type CreatorMarginsInput,
  type CreatorOwnPricesInput,
} from "@dashmani/shared/src/validators/creator";
import { AppError } from "../../middleware/error-handler";
import { invalidateCatalogueCache, listCreatorTargets } from "../campaign/rate-card.service";

// Creator page pricing (owner decision 2026-11-04, keeping the recorded Phase C decision):
//  • the CREATOR sets their own price per page and format (creators.digitalsukoon.com → Prices).
//    That price IS their payout;
//  • STAFF add our margin on top (internal portal /creators/[id] → Prices): a percentage for
//    brand campaigns, an optional percentage for entertainment campaigns, and the reel song
//    add-on as a fixed client charge. Staff never type the payout or the client price;
//  • client price = creatorClientPricePaise(creator price, margin) — creator price + margin %,
//    rounded UP to a whole rupee (packages/shared, so the staff preview uses the same rule).
//
// Both sides live in creator_page_prices. The client-facing rate card (campaign_rate_cards,
// target_type "creator_asset") is DERIVED from it by syncCreatorCards() after every change on
// either side, so priceFor(), checkout, GST and refunds treat a creator page like one of ours.
// A format is listed only while the creator has a price AND staff have set a brand margin AND
// staff left it active; otherwise its card is switched off (kept, never deleted — booked items
// name it).
//
// When the creator changes their price, the client price for NEW bookings follows automatically
// (the margin is a percentage). It never changes a post already in a booking: checkout freezes
// the client price AND the payout on the item (payment.service), and the offer keeps that payout.
//
// ⚠️ The creator never sees the margin or the client price; the client never sees the payout.

const PLATFORM_OF: Record<string, "instagram" | "facebook"> = { instagram_account: "instagram", facebook_page: "facebook" };

type Tx = Prisma.TransactionClient;

/** Rebuild the derived rate cards of these pages from creator_page_prices. Inside the caller's tx. */
export async function syncCreatorCards(tx: Tx, assetIds: string[], staffId: string | null) {
  if (assetIds.length === 0) return;
  const [assets, rows, cards] = await Promise.all([
    tx.creatorAsset.findMany({ where: { id: { in: assetIds } }, select: { id: true, kind: true } }),
    tx.creatorPagePrice.findMany({ where: { assetId: { in: assetIds } } }),
    tx.campaignRateCard.findMany({ where: { targetType: "creator_asset", targetId: { in: assetIds } } }),
  ]);
  const kindOf = new Map(assets.map((a) => [a.id, a.kind]));
  const rowOf = new Map(rows.map((r) => [`${r.assetId}:${r.format}`, r]));
  const cardOf = new Map(cards.map((c) => [`${c.targetId}:${c.format}`, c]));
  for (const assetId of assetIds) {
    const kind = kindOf.get(assetId);
    if (!kind) continue;
    for (const format of CREATOR_PRICED_FORMATS) {
      const r = rowOf.get(`${assetId}:${format}`);
      const card = cardOf.get(`${assetId}:${format}`);
      const complete = r && r.active && r.creatorPricePaise != null && r.marginBps != null;
      if (!complete) {
        // Not listable: switch the card off, keep it (booked items reference its id).
        if (card?.active) await tx.campaignRateCard.update({ where: { id: card.id }, data: { active: false, updatedById: staffId ?? card.updatedById } });
        continue;
      }
      const data = {
        platform: PLATFORM_OF[kind],
        pricePaise: creatorClientPricePaise(r.creatorPricePaise!, r.marginBps!),
        entertainmentPricePaise: r.entertainmentMarginBps != null ? creatorClientPricePaise(r.creatorPricePaise!, r.entertainmentMarginBps) : null,
        audioAddonPaise: format === "reel" ? r.audioAddonPaise : null,
        creatorPayoutPaise: r.creatorPricePaise,
        active: true,
        ...(staffId ? { updatedById: staffId } : {}),
      };
      if (card) await tx.campaignRateCard.update({ where: { id: card.id }, data });
      else await tx.campaignRateCard.create({ data: { targetType: "creator_asset", targetId: assetId, format, ...data } });
    }
  }
}

// ── Staff ─────────────────────────────────────────────────────────────────────────────────────

export async function getCreatorPricing(creatorId: string) {
  const assets = await prisma.creatorAsset.findMany({
    where: { creatorId },
    orderBy: [{ disconnectedAt: { sort: "asc", nulls: "first" } }, { kind: "asc" }, { name: "asc" }],
    select: { id: true, kind: true, name: true, username: true, followerCount: true, enabled: true, disconnectedAt: true },
  });
  if (assets.length === 0) {
    const exists = await prisma.creator.findUnique({ where: { id: creatorId }, select: { id: true } });
    if (!exists) throw new AppError(404, "NOT_FOUND", "Creator not found");
  }
  const ids = assets.map((a) => a.id);
  const [rows, cards, bookable] = await Promise.all([
    prisma.creatorPagePrice.findMany({ where: { assetId: { in: ids } } }),
    prisma.campaignRateCard.findMany({ where: { targetType: "creator_asset", targetId: { in: ids } } }),
    listCreatorTargets(),
  ]);
  const bookableIds = new Set(bookable.map((t) => t.targetId));
  return assets.map((a) => {
    const own = cards.filter((c) => c.targetId === a.id);
    return {
      assetId: a.id,
      kind: a.kind,
      platform: PLATFORM_OF[a.kind],
      name: a.name,
      username: a.username,
      followers: a.followerCount,
      enabled: a.enabled,
      disconnected: a.disconnectedAt != null,
      /** Shown to clients right now (bookable AND at least one active derived price). */
      listed: bookableIds.has(a.id) && own.some((c) => c.active),
      category: own.find((c) => c.category)?.category ?? null,
      formats: CREATOR_PRICED_FORMATS.map((format) => {
        const r = rows.find((x) => x.assetId === a.id && x.format === format);
        const card = own.find((c) => c.format === format);
        return {
          format,
          creatorPricePaise: r?.creatorPricePaise ?? null,
          creatorUpdatedAt: r?.creatorUpdatedAt ?? null,
          marginBps: r?.marginBps ?? null,
          entertainmentMarginBps: r?.entertainmentMarginBps ?? null,
          audioAddonPaise: format === "reel" ? r?.audioAddonPaise ?? null : null,
          active: r?.active ?? true,
          /** The derived client prices as listed (null = not listed for that campaign type). */
          clientPricePaise: card?.active ? card.pricePaise : null,
          entertainmentClientPricePaise: card?.active ? card.entertainmentPricePaise : null,
        };
      }),
    };
  });
}

/** Staff set our margin (and song add-on / category / active) — never the payout. */
export async function setCreatorMargins(creatorId: string, input: CreatorMarginsInput, staffId: string) {
  const ids = [...new Set(input.cards.map((c) => c.assetId))];
  const owned = await prisma.creatorAsset.findMany({ where: { id: { in: ids }, creatorId }, select: { id: true } });
  if (owned.length !== ids.length) throw new AppError(404, "NOT_FOUND", "One of the pages doesn't belong to this creator.");
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    for (const c of input.cards) {
      const staff = {
        marginBps: c.marginBps,
        ...(c.entertainmentMarginBps !== undefined ? { entertainmentMarginBps: c.entertainmentMarginBps } : {}),
        ...(c.audioAddonPaise !== undefined ? { audioAddonPaise: c.format === "reel" ? c.audioAddonPaise : null } : {}),
        active: c.active ?? true,
        staffUpdatedById: staffId,
        staffUpdatedAt: now,
      };
      await tx.creatorPagePrice.upsert({
        where: { assetId_format: { assetId: c.assetId, format: c.format } },
        create: { assetId: c.assetId, format: c.format, ...staff },
        update: staff,
      });
    }
    await syncCreatorCards(tx, ids, staffId);
    // Category is per page: the same on every format's card.
    for (const c of input.cards) {
      if (c.category === undefined) continue;
      await tx.campaignRateCard.updateMany({ where: { targetType: "creator_asset", targetId: c.assetId }, data: { category: c.category } });
    }
  });
  invalidateCatalogueCache();
  return { pages: await getCreatorPricing(creatorId) };
}

// ── Creator ───────────────────────────────────────────────────────────────────────────────────

/** The creator's own prices. Explicit fields only: no margin, no client price. */
export async function getOwnPrices(creatorId: string) {
  const assets = await prisma.creatorAsset.findMany({
    where: { creatorId, disconnectedAt: null },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
    select: { id: true, kind: true, name: true, username: true, enabled: true, prices: { select: { format: true, creatorPricePaise: true, creatorUpdatedAt: true } } },
  });
  return assets.map((a) => ({
    assetId: a.id,
    platform: PLATFORM_OF[a.kind],
    name: a.name,
    username: a.username,
    /** Our team has switched this page on for bookings. */
    enabled: a.enabled,
    prices: CREATOR_PRICED_FORMATS.map((format) => {
      const p = a.prices.find((x) => x.format === format);
      return { format, pricePaise: p?.creatorPricePaise ?? null, updatedAt: p?.creatorUpdatedAt ?? null };
    }),
  }));
}

/**
 * The creator sets their own price (= payout) per page and format. New bookings follow it at
 * once (client price = price + our margin); posts already booked keep the price they were booked at.
 */
export async function setOwnPrices(creatorId: string, input: CreatorOwnPricesInput) {
  const ids = [...new Set(input.prices.map((p) => p.assetId))];
  const owned = await prisma.creatorAsset.findMany({ where: { id: { in: ids }, creatorId, disconnectedAt: null }, select: { id: true } });
  if (owned.length !== ids.length) throw new AppError(404, "NOT_FOUND", "One of the pages isn't connected to your account.");
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    for (const p of input.prices) {
      await tx.creatorPagePrice.upsert({
        where: { assetId_format: { assetId: p.assetId, format: p.format } },
        create: { assetId: p.assetId, format: p.format, creatorPricePaise: p.pricePaise, creatorUpdatedAt: now },
        update: { creatorPricePaise: p.pricePaise, creatorUpdatedAt: now },
      });
    }
    await syncCreatorCards(tx, ids, null);
  });
  invalidateCatalogueCache();
  return getOwnPrices(creatorId);
}
