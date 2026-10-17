import { prisma } from "@dashmani/db";
import {
  type CampaignRateCardUpsertInput,
  type CampaignProvider,
  CREATOR_MIN_PAYOUT_PAISE,
  CREATOR_SHARE_MAX_BPS,
  CREATOR_TARGET_TYPE as CREATOR_TARGET,
  formatPaise,
  PLATFORM_FORMATS,
  type CampaignPlatform,
  type CampaignFormat,
} from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { resolveDuplicateAssetIds } from "../meta-oauth/meta-channels.service";
import { createSingleFlightMemo } from "../../utils/single-flight-memo";
import { creatorConfig } from "../creator/creator-config";
import { bankChangeBlocksRelease } from "../creator/payout-account-view";
import { computePayout } from "../creator/payout-math";
import { liveConnectionWhere, profileUrl as creatorProfileUrl } from "../creator/creator-view";
import { LINK_DELIVERY_MINUTES } from "./config";

// Rate cards (our price per account per format) and the client-facing catalogue built from
// them. A "target" is a connected Meta asset (Facebook Page / Instagram account), a tracked
// social_accounts row (YouTube — not publishable through Meta, posted by staff), or a CREATOR's page
// (`creator_asset`: a page that belongs to a creator, paid out by the creator-payout flow).
//
// ⚠️ The catalogue is served to CLIENTS. It returns explicit fields only: never earnings,
// tokens, connection ids or anything else from meta_assets beyond what is listed below.
//
// ⚠️ TWO LISTS OF CREATOR PAGES, and they differ on purpose:
//   • listCreatorTargets()  — what STAFF can price: the creator is approved and the page is switched on,
//     publishable, not a duplicate of our own network and on a live connection. No switches involved: staff
//     can set a page up while the marketplace is still dark.
//   • listBookableTargets() / getCatalogue() — what a CLIENT can book. Everything above PLUS the creator portal's
//     master switch, the marketplace and Route switches and Razorpay's keys (creatorConfig.marketplaceAvailable()),
//     an ACTIVATED payout account that is past its 24-hour wait with no bank
//     change in flight, and (in getCatalogue) an active card WITH a share. Evaluated on EVERY read, never cached,
//     so a suspended creator, a lapsed payout account or a bank change takes the page out of the list at once.
// listRateCardGrid() (our own network's grid) never contains a creator page.

export type TargetType = "meta_asset" | "social_account" | "creator_asset";

/** What the booking flow needs to know about a creator page's owner. Server-internal: never put in a client response. */
export interface CreatorTargetMeta {
  creatorId: string;
  creatorName: string;
  payoutAccountId: string | null;
  razorpayAccountId: string | null;
  tdsBps: number;
  /** null = a client can book it today (the switches aside); otherwise why not, for the staff screen. */
  notBookable: "no_payout_account" | "payout_not_activated" | "bookable_later" | "bank_change" | null;
}

export interface CatalogueTarget {
  targetType: TargetType;
  targetId: string;
  platform: CampaignPlatform;
  name: string;
  username: string | null;
  pictureUrl: string | null;
  followers: number | null;
  views28d: number | null;
  engagements28d: number | null;
  /** engagements ÷ views over Meta's last 28 days, as a percentage. null when unknown. */
  engagementRatePct: number | null;
  profileUrl: string | null;
  /** Creator pages only. */
  creator?: CreatorTargetMeta;
}

const big = (v: bigint | null | undefined) => (v == null ? null : Number(v));

function engagementRate(eng: number | null, views: number | null): number | null {
  if (eng == null || views == null || views <= 0) return null;
  return Math.round((eng / views) * 10_000) / 100;
}

function metaProfileUrl(kind: string, metaId: string, username: string | null): string | null {
  if (kind === "FACEBOOK_PAGE") return /^\d+$/.test(metaId) ? `https://www.facebook.com/${metaId}` : null;
  return username ? `https://www.instagram.com/${encodeURIComponent(username)}/` : null;
}

/**
 * Our own network's accounts: live, monitored Meta assets (duplicates suppressed, as everywhere
 * else) and active YouTube channels. Never contains a creator's page.
 */
async function listNetworkTargets(): Promise<CatalogueTarget[]> {
  const [assets, hidden, yt] = await Promise.all([
    prisma.metaAsset.findMany({
      where: { disconnectedAt: null, selected: true },
      select: {
        id: true,
        kind: true,
        metaId: true,
        name: true,
        username: true,
        pictureUrl: true,
        followerCount: true,
        views28d: true,
        engagements28d: true,
      },
    }),
    resolveDuplicateAssetIds(),
    prisma.socialAccount.findMany({
      where: { status: "ACTIVE", platform: { slug: "youtube" } },
      select: { id: true, handle: true, displayName: true, followerCount: true, profileUrl: true },
    }),
  ]);
  const out: CatalogueTarget[] = [];
  for (const a of assets) {
    if (hidden.has(a.id)) continue;
    const views = big(a.views28d);
    const eng = big(a.engagements28d);
    out.push({
      targetType: "meta_asset",
      targetId: a.id,
      platform: a.kind === "FACEBOOK_PAGE" ? "facebook" : "instagram",
      name: a.name,
      username: a.username,
      pictureUrl: a.pictureUrl,
      followers: a.followerCount,
      views28d: views,
      engagements28d: eng,
      engagementRatePct: engagementRate(eng, views),
      profileUrl: metaProfileUrl(a.kind, a.metaId, a.username),
    });
  }
  for (const s of yt) {
    out.push({
      targetType: "social_account",
      targetId: s.id,
      platform: "youtube",
      name: s.displayName,
      username: s.handle.replace(/^@/, ""),
      pictureUrl: null,
      followers: s.followerCount > 0 ? s.followerCount : null,
      views28d: null,
      engagements28d: null,
      engagementRatePct: null,
      profileUrl: s.profileUrl,
    });
  }
  return out;
}


// ── Creator pages ───────────────────────────────────────────────────────────────

type PayoutAccountFacts = {
  id: string;
  creatorId: string;
  razorpayAccountId: string | null;
  activationStatus: string;
  bookableAfter: Date | null;
  bankChangeRequestedAt: Date | null;
  bankChangeClearedAt: Date | null;
  tdsBps: number;
};

/**
 * Why a creator's payout account can't take a booking today, or null when it can. A booking pays the creator's
 * share into their Razorpay linked account, so the account must exist, be ACTIVATED, be past its wait
 * (bookable_after: 24 hours after activation, the cautious reading of Razorpay's two statements) and have no bank
 * change in flight (bankChangeBlocksRelease: from the request until staff clear it, plus 72 hours).
 */
function notBookableReason(acct: PayoutAccountFacts | null | undefined, now: Date): CreatorTargetMeta["notBookable"] {
  if (!acct || !acct.razorpayAccountId) return "no_payout_account";
  if (acct.activationStatus !== "activated") return "payout_not_activated";
  if (!acct.bookableAfter || now.getTime() < acct.bookableAfter.getTime()) return "bookable_later";
  if (bankChangeBlocksRelease(acct, now)) return "bank_change";
  return null;
}

/**
 * The creator pages STAFF can price (see the header): approved creator, page switched on, publishable, not
 * a duplicate of our own network, connection live. `creator.notBookable` says whether a CLIENT could book it
 * today (ignoring the switches). Read fresh every time.
 *
 * ⚠️ `audience: "client"` (the booking path: bookableCreatorPages) never reads the creator's Page Insights at
 * all: views28d / engagements28d come from the creator's OWN token (creator-metrics.service) and are private
 * analytics, while the creators' privacy page promises brands only a page's "name, picture and public
 * statistics". A client-path target carries null for views28d, engagements28d and engagementRatePct, so no
 * later field-copy can hand them to a brand. Staff (the default) still see them to price a page.
 */
export async function listCreatorTargets(opts: { onlyIds?: string[]; audience?: "staff" | "client" } = {}): Promise<CatalogueTarget[]> {
  const forClient = opts.audience === "client";
  if (opts.onlyIds && opts.onlyIds.length === 0) return [];
  const assets = await prisma.creatorAsset.findMany({
    where: {
      enabled: true,
      canPublish: true,
      networkDuplicateOf: null,
      disconnectedAt: null,
      creator: { status: "approved" },
      connection: liveConnectionWhere,
      ...(opts.onlyIds ? { id: { in: opts.onlyIds } } : {}),
    },
    select: {
      id: true,
      kind: true,
      metaId: true,
      name: true,
      username: true,
      pictureUrl: true,
      followerCount: true,
      ...(forClient ? {} : { views28d: true, engagements28d: true }),
      creatorId: true,
      creator: { select: { name: true } },
    },
  });
  if (assets.length === 0) return [];
  const accounts = await prisma.creatorPayoutAccount.findMany({
    where: { creatorId: { in: [...new Set(assets.map((a) => a.creatorId))] } },
    select: { id: true, creatorId: true, razorpayAccountId: true, activationStatus: true, bookableAfter: true, bankChangeRequestedAt: true, bankChangeClearedAt: true, tdsBps: true },
  });
  const byCreator = new Map(accounts.map((a) => [a.creatorId, a]));
  const now = new Date();
  return assets.map((a): CatalogueTarget => {
    const acct = byCreator.get(a.creatorId) ?? null;
    // Private Page Insights: staff only (see above). A client-audience row never even had them selected.
    const views = forClient ? null : big(a.views28d);
    const eng = forClient ? null : big(a.engagements28d);
    return {
      targetType: "creator_asset",
      targetId: a.id,
      platform: a.kind === "facebook_page" ? "facebook" : "instagram",
      name: a.name,
      username: a.username,
      pictureUrl: a.pictureUrl,
      followers: a.followerCount,
      views28d: views,
      engagements28d: eng,
      engagementRatePct: engagementRate(eng, views),
      profileUrl: creatorProfileUrl({ kind: a.kind, metaId: a.metaId, username: a.username }),
      creator: {
        creatorId: a.creatorId,
        creatorName: a.creator.name,
        payoutAccountId: acct?.id ?? null,
        razorpayAccountId: acct?.razorpayAccountId ?? null,
        tdsBps: acct?.tdsBps ?? 0,
        notBookable: notBookableReason(acct, now),
      },
    };
  });
}

type OfferableCard = Awaited<ReturnType<typeof prisma.campaignRateCard.findMany<{ include: { creatorTerm: true } }>>>[number];

/**
 * The creator pages a CLIENT can book, each with the cards that are really on offer. A page counts only when ALL of
 * this holds: the creator portal's master switch, the marketplace + Route switches and Razorpay's keys are on; the creator is approved and the page is
 * switched on, publishable and live (listCreatorTargets); the payout account can take a booking (activated, past its
 * wait, no bank change in flight); and at least one of its cards is ACTIVE, has a share, and still pays the creator the
 * minimum at its lowest price. EMPTY (and no query at all) while any switch is off. Read fresh on every call.
 */
async function bookableCreatorPages(opts: { onlyIds?: string[] } = {}): Promise<Array<{ target: CatalogueTarget; cards: OfferableCard[] }>> {
  if (!creatorConfig.marketplaceAvailable()) return [];
  // The CLIENT audience: no private Page Insights (see listCreatorTargets).
  const targets = (await listCreatorTargets({ ...opts, audience: "client" })).filter((t) => t.creator?.notBookable === null);
  if (targets.length === 0) return [];
  const cards = await prisma.campaignRateCard.findMany({
    where: { targetType: CREATOR_TARGET, active: true, targetId: { in: targets.map((t) => t.targetId) }, creatorTerm: { isNot: null } },
    include: { creatorTerm: true },
  });
  const byTarget = new Map<string, OfferableCard[]>();
  for (const c of cards) byTarget.set(c.targetId, [...(byTarget.get(c.targetId) ?? []), c]);
  const out: Array<{ target: CatalogueTarget; cards: OfferableCard[] }> = [];
  for (const t of targets) {
    const own = (byTarget.get(t.targetId) ?? []).filter(
      (c) => (PLATFORM_FORMATS[t.platform] as readonly string[]).includes(c.format) && creatorCardOfferable(c, c.creatorTerm, t.creator?.tdsBps ?? 0),
    );
    if (own.length > 0) out.push({ target: t, cards: own });
  }
  return out;
}

/** The creator pages a CLIENT can book today (see bookableCreatorPages). */
export async function listBookableCreatorTargets(opts: { onlyIds?: string[] } = {}): Promise<CatalogueTarget[]> {
  return (await bookableCreatorPages(opts)).map((p) => p.target);
}

/**
 * Every account a CLIENT can book today: our own network's, plus (only while the creator marketplace is
 * available) the creator pages whose owners can be paid. With the switches off this is exactly the old list.
 */
export async function listBookableTargets(): Promise<CatalogueTarget[]> {
  const [network, creators] = await Promise.all([listNetworkTargets(), listBookableCreatorTargets()]);
  return creators.length === 0 ? network : [...network, ...creators];
}

/**
 * Resolve the given targets to their live catalogue entries (missing = no longer bookable).
 * `audience` decides which creator pages count: "client" (the default: booking, checkout) only the ones a client
 * can book today; "staff" (the rate-card editor) every page staff can price, switches or not.
 */
export async function resolveCatalogueTargets(
  keys: Array<{ targetType: string; targetId: string }>,
  opts: { audience?: "client" | "staff" } = {},
) {
  const wanted = new Set(keys.map((k) => `${k.targetType}:${k.targetId}`));
  const creatorIds = keys.filter((k) => k.targetType === CREATOR_TARGET).map((k) => k.targetId);
  const [network, creators] = await Promise.all([
    listNetworkTargets(),
    creatorIds.length === 0
      ? Promise.resolve([] as CatalogueTarget[])
      : opts.audience === "staff"
        ? listCreatorTargets({ onlyIds: creatorIds })
        : listBookableCreatorTargets({ onlyIds: creatorIds }),
  ]);
  const map = new Map<string, CatalogueTarget>();
  for (const t of [...network, ...creators]) {
    const k = `${t.targetType}:${t.targetId}`;
    if (wanted.has(k)) map.set(k, t);
  }
  return map;
}

/**
 * Whether a creator page's card can be offered: it has a share (staff set one) and, at its LOWEST price, the
 * creator would still be paid at least CREATOR_MIN_PAYOUT_PAISE after TDS. The lowest price is the cheaper of the
 * Brand and Entertainment prices (the song add-on only raises a price), so passing at the lowest passes at every
 * price a booking can reach. The ONE rule the rate-card editor, the catalogue, the picker and checkout share.
 */
export function creatorCardOfferable(
  card: { pricePaise: number; entertainmentPricePaise: number | null },
  term: { shareBps: number } | null | undefined,
  tdsBps: number,
): boolean {
  if (!term || term.shareBps < 1 || term.shareBps > CREATOR_SHARE_MAX_BPS) return false;
  const lowest = Math.min(card.pricePaise, card.entertainmentPricePaise ?? Number.POSITIVE_INFINITY);
  return computePayout(lowest, term.shareBps, tdsBps).amountPaise >= CREATOR_MIN_PAYOUT_PAISE;
}

// ── Pricing (the ONE place a booking price is decided) ───────────────────────────

export interface PricedCard {
  pricePaise: number;
  entertainmentPricePaise: number | null;
  audioAddonPaise: number | null;
}

/**
 * The price of one account for a booking: the campaign type picks the base (Brand or
 * Entertainment column), and a reel with song audio integration adds the account's audio
 * add-on. null = this account does not offer what the booking asks for.
 */
export function priceFor(
  card: PricedCard,
  booking: { campaignType: string; audioIntegration: boolean; format: string | null },
): { base: number; addon: number; total: number } | null {
  const base = booking.campaignType === "entertainment" ? card.entertainmentPricePaise : card.pricePaise;
  if (base == null) return null;
  let addon = 0;
  if (booking.audioIntegration && booking.format === "reel") {
    if (card.audioAddonPaise == null) return null;
    addon = card.audioAddonPaise;
  }
  return { base, addon, total: base + addon };
}

// ── Admin: the rate-card grid ───────────────────────────────────────────────────

/** Our own network's grid. ⚠️ Never lists a creator page: those are priced on their own screen (listCreatorRateCardGrid). */
export async function listRateCardGrid() {
  const [targets, cards] = await Promise.all([
    listNetworkTargets(),
    prisma.campaignRateCard.findMany({ where: { targetType: { not: CREATOR_TARGET } } }),
  ]);
  const byTarget = new Map<string, typeof cards>();
  for (const c of cards) {
    const k = `${c.targetType}:${c.targetId}`;
    byTarget.set(k, [...(byTarget.get(k) ?? []), c]);
  }
  return targets
    .map((t) => {
      const own = byTarget.get(`${t.targetType}:${t.targetId}`) ?? [];
      return {
        ...t,
        category: own.find((c) => c.category)?.category ?? null,
        formats: PLATFORM_FORMATS[t.platform],
        cards: own.map((c) => ({
          id: c.id,
          format: c.format,
          pricePaise: c.pricePaise,
          entertainmentPricePaise: c.entertainmentPricePaise,
          audioAddonPaise: c.audioAddonPaise,
          active: c.active,
        })),
      };
    })
    .sort((a, b) => (b.followers ?? 0) - (a.followers ?? 0) || a.name.localeCompare(b.name));
}

/**
 * STAFF ONLY: the creator pages that can be priced (listCreatorTargets), each with its cards and their shares.
 * `creator` carries who owns the page and whether a client could book it today (`bookable`, `notBookable`: the
 * payout account's state; the marketplace switches are separate and not reflected here).
 */
export async function listCreatorRateCardGrid() {
  const targets = await listCreatorTargets();
  if (targets.length === 0) return [];
  const cards = await prisma.campaignRateCard.findMany({
    where: { targetType: CREATOR_TARGET, targetId: { in: targets.map((t) => t.targetId) } },
    include: { creatorTerm: true },
  });
  const byTarget = new Map<string, typeof cards>();
  for (const c of cards) byTarget.set(c.targetId, [...(byTarget.get(c.targetId) ?? []), c]);
  return targets
    .map((t) => {
      const own = byTarget.get(t.targetId) ?? [];
      const { creator, ...page } = t;
      return {
        ...page,
        creator: creator
          ? { id: creator.creatorId, name: creator.creatorName, tdsBps: creator.tdsBps, bookable: creator.notBookable === null, notBookable: creator.notBookable }
          : null,
        category: own.find((c) => c.category)?.category ?? null,
        formats: PLATFORM_FORMATS[t.platform],
        cards: own.map((c) => ({
          id: c.id,
          format: c.format,
          pricePaise: c.pricePaise,
          entertainmentPricePaise: c.entertainmentPricePaise,
          audioAddonPaise: c.audioAddonPaise,
          active: c.active,
          shareBps: c.creatorTerm?.shareBps ?? null,
        })),
      };
    })
    .sort((a, b) => (b.followers ?? 0) - (a.followers ?? 0) || a.name.localeCompare(b.name));
}

export async function upsertRateCards(input: CampaignRateCardUpsertInput, staffId: string) {
  // Staff may price any creator page staff can price, whether or not the marketplace is switched on yet.
  const targets = await resolveCatalogueTargets(input.cards, { audience: "staff" });
  let upserted = 0;
  let deleted = 0;
  await prisma.$transaction(async (tx) => {
    for (const c of input.cards) {
      const t = targets.get(`${c.targetType}:${c.targetId}`);
      if (!t) throw new AppError(400, "UNKNOWN_ACCOUNT", "One of the accounts is not connected any more. Refresh the page.");
      if (!(PLATFORM_FORMATS[t.platform] as readonly CampaignFormat[]).includes(c.format)) {
        throw new AppError(400, "FORMAT_NOT_SUPPORTED", `${t.platform} has no ${c.format} format.`);
      }
      const isCreator = c.targetType === CREATOR_TARGET;
      if (!isCreator && c.shareBps !== undefined) throw new AppError(400, "VALIDATION_ERROR", "A share applies to creator pages only.");
      const where = { targetType_targetId_format: { targetType: c.targetType, targetId: c.targetId, format: c.format } };
      if (c.pricePaise == null) {
        const r = await tx.campaignRateCard.deleteMany({ where: { targetType: c.targetType, targetId: c.targetId, format: c.format } });
        deleted += r.count;
        continue;
      }
      let shareBps: number | null = null;
      if (isCreator) {
        shareBps = c.shareBps ?? null;
        if (shareBps === null || !Number.isInteger(shareBps) || shareBps < 1) throw new AppError(400, "VALIDATION_ERROR", "Set the creator's share.");
        if (shareBps > CREATOR_SHARE_MAX_BPS) {
          throw new AppError(400, "SHARE_TOO_HIGH", `A creator's share can be at most ${CREATOR_SHARE_MAX_BPS / 100}% of the price.`);
        }
        // The payout floor is judged at the card's LOWEST price (Brand or Entertainment, whichever is cheaper; the
        // song add-on is left out because it only raises a price). An omitted entertainment price keeps the stored one.
        const existing = await tx.campaignRateCard.findUnique({ where, select: { entertainmentPricePaise: true } });
        const entertainment = c.entertainmentPricePaise !== undefined ? c.entertainmentPricePaise : existing?.entertainmentPricePaise ?? null;
        const lowest = Math.min(c.pricePaise, entertainment ?? Number.POSITIVE_INFINITY);
        const payout = computePayout(lowest, shareBps, t.creator?.tdsBps ?? 0).amountPaise;
        if (payout < CREATOR_MIN_PAYOUT_PAISE) {
          throw new AppError(
            400,
            "PAYOUT_TOO_LOW",
            `At the lowest price on this card (${formatPaise(lowest)}) the creator would be paid ${formatPaise(payout)}, which is under the ${formatPaise(CREATOR_MIN_PAYOUT_PAISE)} minimum. Raise the price or the share.`,
          );
        }
      }
      const card = await tx.campaignRateCard.upsert({
        where,
        create: {
          targetType: c.targetType,
          targetId: c.targetId,
          platform: t.platform,
          format: c.format,
          pricePaise: c.pricePaise,
          entertainmentPricePaise: c.entertainmentPricePaise ?? null,
          audioAddonPaise: c.format === "reel" ? c.audioAddonPaise ?? null : null,
          active: c.active ?? true,
          category: c.category ?? null,
          updatedById: staffId,
        },
        update: {
          pricePaise: c.pricePaise,
          ...(c.entertainmentPricePaise !== undefined ? { entertainmentPricePaise: c.entertainmentPricePaise } : {}),
          ...(c.audioAddonPaise !== undefined ? { audioAddonPaise: c.format === "reel" ? c.audioAddonPaise : null } : {}),
          active: c.active ?? true,
          ...(c.category !== undefined ? { category: c.category } : {}),
          updatedById: staffId,
        },
        select: { id: true },
      });
      if (shareBps !== null) {
        await tx.creatorRateTerm.upsert({
          where: { rateCardId: card.id },
          create: { rateCardId: card.id, shareBps, updatedById: staffId },
          update: { shareBps, updatedById: staffId },
        });
      }
      upserted++;
    }
    // Category is per account: keep it the same on every format of that account.
    for (const c of input.cards) {
      if (c.category === undefined) continue;
      await tx.campaignRateCard.updateMany({
        where: { targetType: c.targetType, targetId: c.targetId },
        data: { category: c.category },
      });
    }
  });
  invalidateCatalogueCache();
  return { upserted, deleted };
}

// ── Client: the catalogue ───────────────────────────────────────────────────────

/**
 * Memoised: OUR NETWORK's entries only. Creator pages are read fresh on every call (see getCatalogue), so
 * clearing this cache is never what keeps a suspended creator's page out of a client's list.
 */
const catalogueMemo = createSingleFlightMemo({ ttlMs: 60_000, maxEntries: 10 });
export function invalidateCatalogueCache() {
  catalogueMemo.clear();
}

export interface CatalogueEntry {
  targetType: TargetType;
  targetId: string;
  platform: CampaignPlatform;
  name: string;
  username: string | null;
  pictureUrl: string | null;
  followers: number | null;
  engagementRatePct: number | null;
  views28d: number | null;
  category: string | null;
  profileUrl: string | null;
  /** How long after posting the link is ready (approximate). Same for every account today. */
  linkDeliveryMinutes: { min: number; max: number };
  /**
   * Who provides this post: our network, or a creator, NAMED. The client always knows who is paid for a post
   * (payer-payee transparency); nothing else of the creator (id, share, tax, payout) is ever in this response.
   */
  provider: CampaignProvider;
  /** pricePaise = brand price; entertainmentPricePaise / audioAddonPaise null when not offered. */
  offers: Array<{
    rateCardId: string;
    format: CampaignFormat;
    pricePaise: number;
    entertainmentPricePaise: number | null;
    audioAddonPaise: number | null;
  }>;
}

const byFollowersThenName = (a: CatalogueEntry, b: CatalogueEntry) => (b.followers ?? 0) - (a.followers ?? 0) || a.name.localeCompare(b.name);

async function networkCatalogue(): Promise<CatalogueEntry[]> {
  return catalogueMemo.memo("all", async () => {
    const [targets, cards] = await Promise.all([
      listNetworkTargets(),
      prisma.campaignRateCard.findMany({ where: { active: true, targetType: { not: CREATOR_TARGET } } }),
    ]);
    const byTarget = new Map<string, typeof cards>();
    for (const c of cards) {
      const k = `${c.targetType}:${c.targetId}`;
      byTarget.set(k, [...(byTarget.get(k) ?? []), c]);
    }
    const out: CatalogueEntry[] = [];
    for (const t of targets) {
      const own = byTarget.get(`${t.targetType}:${t.targetId}`);
      if (!own?.length) continue;
      out.push({
        targetType: t.targetType,
        targetId: t.targetId,
        platform: t.platform,
        name: t.name,
        username: t.username,
        pictureUrl: t.pictureUrl,
        followers: t.followers,
        engagementRatePct: t.engagementRatePct,
        views28d: t.views28d,
        category: own.find((c) => c.category)?.category ?? null,
        profileUrl: t.profileUrl,
        linkDeliveryMinutes: { ...LINK_DELIVERY_MINUTES },
        provider: { type: "network", name: null },
        offers: own
          .filter((c) => (PLATFORM_FORMATS[t.platform] as readonly string[]).includes(c.format))
          .map((c) => ({
            rateCardId: c.id,
            format: c.format as CampaignFormat,
            pricePaise: c.pricePaise,
            entertainmentPricePaise: c.entertainmentPricePaise,
            audioAddonPaise: c.audioAddonPaise,
          })),
      });
    }
    return out.sort(byFollowersThenName);
  });
}

/**
 * Creator pages a client can book right now: every condition of bookableCreatorPages, and only the cards that are on
 * offer. Explicit fields only.
 */
async function creatorCatalogue(): Promise<CatalogueEntry[]> {
  const out: CatalogueEntry[] = [];
  for (const { target: t, cards: own } of await bookableCreatorPages()) {
    out.push({
      targetType: t.targetType,
      targetId: t.targetId,
      platform: t.platform,
      name: t.name,
      username: t.username,
      pictureUrl: t.pictureUrl,
      followers: t.followers,
      // ⚠️ Always null for a creator's page, whatever the target carries: a creator's reach and engagement are their
      // private Page Insights, not public statistics, and are not shown to brands. The keys stay (same shape as a
      // network entry) and the picker renders null as a dash.
      engagementRatePct: null,
      views28d: null,
      category: own.find((c) => c.category)?.category ?? null,
      profileUrl: t.profileUrl,
      linkDeliveryMinutes: { ...LINK_DELIVERY_MINUTES },
      provider: { type: "creator", name: t.creator?.creatorName ?? null },
      offers: own.map((c) => ({
        rateCardId: c.id,
        format: c.format as CampaignFormat,
        pricePaise: c.pricePaise,
        entertainmentPricePaise: c.entertainmentPricePaise,
        audioAddonPaise: c.audioAddonPaise,
      })),
    });
  }
  return out;
}

/** Bookable accounts with at least one active price. Only the listed fields leave the server. */
export async function getCatalogue(): Promise<CatalogueEntry[]> {
  const network = await networkCatalogue();
  // Dark unless the marketplace is switched on AND Route is on AND Razorpay is configured: then this IS the old list.
  if (!creatorConfig.marketplaceAvailable()) return network;
  const creators = await creatorCatalogue();
  return creators.length === 0 ? network : [...network, ...creators].sort(byFollowersThenName);
}
