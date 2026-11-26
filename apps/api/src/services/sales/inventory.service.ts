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
//  3. EXTERNAL PAGES (owner, 2026-11-18) — pages we do not own and buy posts on: the partner network
//     (Pinkvilla, Filmygyan…) and each vendor's pages (meme, cricket…), from sales_external_pages
//     (external-pages.service.ts). Sales inventory only: never in the client catalogue, no rate card,
//     quoted as a plain placement line. `source: "external"`; switched-off pages are not listed.

export interface InventoryOffer {
  /** null for an external page (it has no rate card). */
  rateCardId: string | null;
  format: string;
  /** Brand price. null only on an external page that takes no brand posts. */
  pricePaise: number | null;
  entertainmentPricePaise: number | null;
  eventPricePaise: number | null;
  audioAddonPaise: number | null;
  active: boolean;
}

export interface InventoryChannel {
  /** "external": targetId is the sales_external_pages row id. */
  targetType: "meta_asset" | "social_account" | "external";
  /** network = one of our channels (connected or tracked); external = a page we buy posts on. */
  source: "network" | "external";
  /** The vendor who sells an external page (null for our own channels and the partner network). */
  vendorName: string | null;
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

/** The formats an external page's per-post price applies to (the same three clients can book). */
const EXTERNAL_FORMATS = ["reel", "post", "carousel"] as const;

interface ExternalRow {
  id: string;
  platform: string;
  handle: string | null;
  name: string;
  profileUrl: string | null;
  followers: number | null;
  category: string | null;
  brandPaise: number | null;
  entertainmentPaise: number | null;
  eventPaise: number | null;
  audioPaise: number | null;
  vendor: { name: string } | null;
}

function fromExternal(p: ExternalRow): InventoryChannel {
  return {
    targetType: "external",
    source: "external",
    vendorName: p.vendor?.name ?? null,
    targetId: p.id,
    platform: p.platform,
    name: p.name,
    handle: p.handle,
    pictureUrl: null,
    followers: p.followers,
    views28d: null,
    engagements28d: null,
    engagementRatePct: null,
    category: p.category,
    profileUrl: p.profileUrl,
    bookable: false,
    inCatalogue: false,
    offers:
      p.brandPaise == null && p.entertainmentPaise == null && p.eventPaise == null
        ? []
        : EXTERNAL_FORMATS.map((format) => ({
            rateCardId: null,
            format,
            pricePaise: p.brandPaise,
            entertainmentPricePaise: p.entertainmentPaise,
            eventPricePaise: p.eventPaise,
            audioAddonPaise: format === "reel" ? p.audioPaise : null,
            active: true,
          })),
  };
}

function fromCatalogue(t: CatalogueTarget): Omit<InventoryChannel, "offers" | "category" | "bookable" | "inCatalogue"> {
  return {
    source: "network",
    vendorName: null,
    // listBookableTargets() returns our own accounts only; creator pages are not sold here yet.
    targetType: t.targetType as InventoryChannel["targetType"],
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
    const [catalogue, targets, cards, accounts, externals] = await Promise.all([
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
      prisma.salesExternalPage.findMany({
        where: { active: true },
        select: {
          id: true, platform: true, handle: true, name: true, profileUrl: true, followers: true, category: true,
          brandPaise: true, entertainmentPaise: true, eventPaise: true, audioPaise: true, vendor: { select: { name: true } },
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
        { rateCardId: c.id, format: c.format, pricePaise: c.pricePaise, entertainmentPricePaise: c.entertainmentPricePaise, eventPricePaise: c.eventPricePaise, audioAddonPaise: c.audioAddonPaise, active: false },
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
        source: "network",
        vendorName: null,
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
    for (const p of externals) out.push(fromExternal(p));
    // Catalogue channels first (the client portal's own order), then external pages, then the rest by reach.
    const rank = (c: InventoryChannel) => (c.inCatalogue ? 2 : c.source === "external" ? 1 : 0);
    out.sort((x, y) => rank(y) - rank(x) || (y.followers ?? -1) - (x.followers ?? -1) || x.name.localeCompare(y.name));
    return out;
  });
}

/** One channel by target, for the quote builder's "add placement" (null when unknown). */
export async function findInventoryChannel(targetType: string, targetId: string): Promise<InventoryChannel | null> {
  const all = await listInventory();
  return all.find((c) => c.targetType === targetType && c.targetId === targetId) ?? null;
}
