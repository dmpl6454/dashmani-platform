import { prisma } from "@dashmani/db";
import { CREATOR_PRICED_FORMATS, type CreatorPricingInput } from "@dashmani/shared/src/validators/creator";
import { AppError } from "../../middleware/error-handler";
import { invalidateCatalogueCache, listCreatorTargets } from "../campaign/rate-card.service";

// Staff set the price of each creator page, per format, on the internal portal's creator page
// (/creators/[id]). The prices live in campaign_rate_cards (target_type "creator_asset"), so the
// client catalogue, checkout, GST and refunds treat a creator page exactly like one of ours.
//
// ⚠️ OWNER DECISION PENDING: the creator-portal plan recorded "Phase C: the CREATOR sets the
// price". This request has STAFF set it (client price and the creator's payout). If the owner
// keeps the recorded decision, the creator's own price becomes the payout here and staff add
// the margin on top.
//
// Rules:
//  • A page can be priced whatever its state (staff may prepare prices before switching it on);
//    it reaches the client catalogue only while bookable (listCreatorTargets()).
//  • The payout can never exceed what the client pays for that format (brand or entertainment):
//    we would lose money on every post.
//  • Instagram pages take reel / post / carousel; Facebook Pages the same. Song add-on: reels only.

const PLATFORM_OF: Record<string, "instagram" | "facebook"> = { instagram_account: "instagram", facebook_page: "facebook" };

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
  const [cards, bookable] = await Promise.all([
    prisma.campaignRateCard.findMany({ where: { targetType: "creator_asset", targetId: { in: assets.map((a) => a.id) } } }),
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
      /** Listed to clients right now (bookable AND at least one active price). */
      listed: bookableIds.has(a.id) && own.some((c) => c.active),
      category: own.find((c) => c.category)?.category ?? null,
      formats: CREATOR_PRICED_FORMATS,
      cards: own.map((c) => ({
        id: c.id,
        format: c.format,
        pricePaise: c.pricePaise,
        entertainmentPricePaise: c.entertainmentPricePaise,
        audioAddonPaise: c.audioAddonPaise,
        creatorPayoutPaise: c.creatorPayoutPaise,
        active: c.active,
      })),
    };
  });
}

export async function upsertCreatorPricing(creatorId: string, input: CreatorPricingInput, staffId: string) {
  const ids = [...new Set(input.cards.map((c) => c.assetId))];
  const assets = await prisma.creatorAsset.findMany({ where: { id: { in: ids }, creatorId }, select: { id: true, kind: true } });
  const kindOf = new Map(assets.map((a) => [a.id, a.kind]));
  for (const c of input.cards) {
    if (!kindOf.has(c.assetId)) throw new AppError(404, "NOT_FOUND", "One of the pages doesn't belong to this creator.");
    if (c.pricePaise == null) continue;
    const payout = c.creatorPayoutPaise;
    if (payout != null && (payout > c.pricePaise || (c.entertainmentPricePaise != null && payout > c.entertainmentPricePaise))) {
      throw new AppError(400, "PAYOUT_ABOVE_PRICE", "The creator's payout can't be more than what the client pays.");
    }
  }

  let upserted = 0;
  let deleted = 0;
  await prisma.$transaction(async (tx) => {
    for (const c of input.cards) {
      const platform = PLATFORM_OF[kindOf.get(c.assetId)!];
      const key = { targetType: "creator_asset", targetId: c.assetId, format: c.format };
      if (c.pricePaise == null) {
        deleted += (await tx.campaignRateCard.deleteMany({ where: key })).count;
        continue;
      }
      const audio = c.format === "reel" ? c.audioAddonPaise ?? null : null;
      await tx.campaignRateCard.upsert({
        where: { targetType_targetId_format: key },
        create: {
          ...key,
          platform,
          pricePaise: c.pricePaise,
          entertainmentPricePaise: c.entertainmentPricePaise ?? null,
          audioAddonPaise: audio,
          creatorPayoutPaise: c.creatorPayoutPaise ?? null,
          active: c.active ?? true,
          category: c.category ?? null,
          updatedById: staffId,
        },
        update: {
          pricePaise: c.pricePaise,
          ...(c.entertainmentPricePaise !== undefined ? { entertainmentPricePaise: c.entertainmentPricePaise } : {}),
          ...(c.audioAddonPaise !== undefined ? { audioAddonPaise: audio } : {}),
          ...(c.creatorPayoutPaise !== undefined ? { creatorPayoutPaise: c.creatorPayoutPaise } : {}),
          active: c.active ?? true,
          ...(c.category !== undefined ? { category: c.category } : {}),
          updatedById: staffId,
        },
      });
      upserted++;
    }
    // Category is per page: keep it the same on every format.
    for (const c of input.cards) {
      if (c.category === undefined) continue;
      await tx.campaignRateCard.updateMany({ where: { targetType: "creator_asset", targetId: c.assetId }, data: { category: c.category } });
    }
  });
  invalidateCatalogueCache();
  return { upserted, deleted, pages: await getCreatorPricing(creatorId) };
}
