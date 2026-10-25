import { prisma } from "@dashmani/db";
import { listBookableTargets, type CatalogueTarget } from "../campaign/rate-card.service";
import { createSingleFlightMemo } from "../../utils/single-flight-memo";

// The sellable inventory for the sales team: EVERY channel on every platform — the connected
// Meta assets and YouTube channels the client catalogue already knows (listBookableTargets,
// duplicates suppressed), plus every other active social_accounts row (Snapchat, X, the Pages
// and IG accounts that are tracked but not connected) — each with its live numbers and
// whatever rate cards exist. Unlike the client catalogue this is staff-only and lists channels
// WITHOUT a price too, so a quote can be built for any of them at a negotiated price.

export interface InventoryOffer {
  rateCardId: string;
  format: string;
  pricePaise: number;
  entertainmentPricePaise: number | null;
  audioAddonPaise: number | null;
  active: boolean;
}

export interface InventoryChannel {
  targetType: "meta_asset" | "social_account";
  targetId: string;
  platform: string;
  name: string;
  handle: string | null;
  pictureUrl: string | null;
  followers: number | null;
  views28d: number | null;
  engagements28d: number | null;
  engagementRatePct: number | null;
  category: string | null;
  profileUrl: string | null;
  /** True when the channel is in the client catalogue (connected / tracked and priced). */
  bookable: boolean;
  offers: InventoryOffer[];
}

const memo = createSingleFlightMemo({ ttlMs: 60_000, maxEntries: 2 });

export function invalidateInventoryCache(): void {
  memo.clear();
}

function fromCatalogue(t: CatalogueTarget): Omit<InventoryChannel, "offers" | "category" | "bookable"> {
  return {
    targetType: t.targetType,
    targetId: t.targetId,
    platform: t.platform,
    name: t.name,
    handle: t.username,
    pictureUrl: t.pictureUrl,
    followers: t.followers,
    views28d: t.views28d,
    engagements28d: t.engagements28d,
    engagementRatePct: t.engagementRatePct,
    profileUrl: t.profileUrl,
  };
}

export async function listInventory(): Promise<InventoryChannel[]> {
  return memo.memo("all", async () => {
    const [targets, cards, accounts] = await Promise.all([
      listBookableTargets(),
      prisma.campaignRateCard.findMany(),
      prisma.socialAccount.findMany({
        where: { status: "ACTIVE" },
        select: {
          id: true,
          handle: true,
          displayName: true,
          profileUrl: true,
          followerCount: true,
          platform: { select: { slug: true } },
          metaAssets: { where: { disconnectedAt: null }, select: { id: true }, take: 1 },
        },
      }),
    ]);
    const byTarget = new Map<string, InventoryOffer[]>();
    for (const c of cards) {
      const k = `${c.targetType}:${c.targetId}`;
      byTarget.set(k, [
        ...(byTarget.get(k) ?? []),
        { rateCardId: c.id, format: c.format, pricePaise: c.pricePaise, entertainmentPricePaise: c.entertainmentPricePaise, audioAddonPaise: c.audioAddonPaise, active: c.active },
      ]);
    }
    const categoryFor = (k: string) => cards.find((c) => `${c.targetType}:${c.targetId}` === k && c.category)?.category ?? null;

    const out: InventoryChannel[] = [];
    const seenSocial = new Set<string>();
    for (const t of targets) {
      const k = `${t.targetType}:${t.targetId}`;
      if (t.targetType === "social_account") seenSocial.add(t.targetId);
      out.push({ ...fromCatalogue(t), category: categoryFor(k), bookable: true, offers: byTarget.get(k) ?? [] });
    }
    for (const a of accounts) {
      // A tracked Page / IG account that is ALSO a live connected asset is already listed above.
      if (seenSocial.has(a.id) || a.metaAssets.length > 0) continue;
      const k = `social_account:${a.id}`;
      out.push({
        targetType: "social_account",
        targetId: a.id,
        platform: a.platform.slug,
        name: a.displayName || a.handle,
        handle: a.handle,
        pictureUrl: null,
        followers: a.followerCount ?? null,
        views28d: null,
        engagements28d: null,
        engagementRatePct: null,
        category: categoryFor(k),
        profileUrl: a.profileUrl ?? null,
        bookable: false,
        offers: byTarget.get(k) ?? [],
      });
    }
    out.sort((x, y) => (y.followers ?? -1) - (x.followers ?? -1) || x.name.localeCompare(y.name));
    return out;
  });
}

/** One channel by target, for the quote builder's "add placement" (null when unknown). */
export async function findInventoryChannel(targetType: string, targetId: string): Promise<InventoryChannel | null> {
  const all = await listInventory();
  return all.find((c) => c.targetType === targetType && c.targetId === targetId) ?? null;
}
