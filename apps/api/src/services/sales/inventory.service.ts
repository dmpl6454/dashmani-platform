import { prisma } from "@dashmani/db";
import { getCatalogue, listBookableTargets, type CatalogueTarget } from "../campaign/rate-card.service";
import { createSingleFlightMemo } from "../../utils/single-flight-memo";

// The sellable inventory for the sales team, in two layers:
//  1. the CLIENT CATALOGUE — exactly what client.digitalsukoon.com lists under Campaigns: the
//     bookable channels that carry at least one active, platform-valid price. It comes from the
//     same getCatalogue() the client portal is served from, so the two lists can never disagree
//     (same channels, same formats, same prices, same categories). The Inventory page opens on it.
//  2. every other channel — connected Meta assets and YouTube channels without a price, plus
//     every other active social_accounts row (Snapchat, X, the Pages and IG accounts that are
//     tracked but not connected) — with its live numbers but no price, so a quote can still be
//     built for it at a negotiated price. `inCatalogue` tells the two layers apart.

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
  /** True when the channel is connected / tracked by the campaign catalogue (a Meta asset or a YouTube channel). */
  bookable: boolean;
  /** True when the client portal lists it: bookable AND at least one active, platform-valid price. */
  inCatalogue: boolean;
  /** For a catalogue channel: the client portal's offers (all active). Otherwise the rate-card rows it has, none active. */
  offers: InventoryOffer[];
}

const memo = createSingleFlightMemo({ ttlMs: 60_000, maxEntries: 2 });

export function invalidateInventoryCache(): void {
  memo.clear();
}

function fromCatalogue(t: CatalogueTarget): Omit<InventoryChannel, "offers" | "category" | "bookable" | "inCatalogue"> {
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
    const [catalogue, targets, cards, accounts] = await Promise.all([
      getCatalogue(),
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
    const listed = new Map(catalogue.map((e) => [`${e.targetType}:${e.targetId}`, e]));
    // Rate-card rows of channels OUTSIDE the catalogue (withdrawn prices, or a format the platform
    // does not take). Kept on the row as inactive so staff can see a price once existed.
    const byTarget = new Map<string, InventoryOffer[]>();
    for (const c of cards) {
      const k = `${c.targetType}:${c.targetId}`;
      byTarget.set(k, [
        ...(byTarget.get(k) ?? []),
        { rateCardId: c.id, format: c.format, pricePaise: c.pricePaise, entertainmentPricePaise: c.entertainmentPricePaise, audioAddonPaise: c.audioAddonPaise, active: false },
      ]);
    }
    const categoryFor = (k: string) => cards.find((c) => `${c.targetType}:${c.targetId}` === k && c.category)?.category ?? null;

    const out: InventoryChannel[] = [];
    const seenSocial = new Set<string>();
    for (const t of targets) {
      const k = `${t.targetType}:${t.targetId}`;
      if (t.targetType === "social_account") seenSocial.add(t.targetId);
      const e = listed.get(k);
      if (e) {
        out.push({ ...fromCatalogue(t), category: e.category, bookable: true, inCatalogue: true, offers: e.offers.map((o) => ({ ...o, active: true })) });
      } else {
        out.push({ ...fromCatalogue(t), category: categoryFor(k), bookable: true, inCatalogue: false, offers: byTarget.get(k) ?? [] });
      }
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
        inCatalogue: false,
        offers: byTarget.get(k) ?? [],
      });
    }
    // Catalogue channels first (the client portal's own order), then the rest by reach.
    out.sort((x, y) => Number(y.inCatalogue) - Number(x.inCatalogue) || (y.followers ?? -1) - (x.followers ?? -1) || x.name.localeCompare(y.name));
    return out;
  });
}

/** One channel by target, for the quote builder's "add placement" (null when unknown). */
export async function findInventoryChannel(targetType: string, targetId: string): Promise<InventoryChannel | null> {
  const all = await listInventory();
  return all.find((c) => c.targetType === targetType && c.targetId === targetId) ?? null;
}
