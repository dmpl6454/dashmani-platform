import { prisma } from "@dashmani/db";
import { type CampaignRateCardUpsertInput, PLATFORM_FORMATS, type CampaignPlatform, type CampaignFormat } from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { resolveDuplicateAssetIds } from "../meta-oauth/meta-channels.service";
import { createSingleFlightMemo } from "../../utils/single-flight-memo";

// Rate cards (our price per account per format) and the client-facing catalogue built from
// them. A "target" is either a connected Meta asset (Facebook Page / Instagram account) or a
// tracked social_accounts row (YouTube — not publishable through Meta, posted by staff).
//
// ⚠️ The catalogue is served to CLIENTS. It returns explicit fields only: never earnings,
// tokens, connection ids or anything else from meta_assets beyond what is listed below.

export type TargetType = "meta_asset" | "social_account";

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
 * Every account that can be put on a rate card: live, monitored Meta assets (duplicates
 * suppressed, as everywhere else) and active YouTube channels.
 */
export async function listBookableTargets(): Promise<CatalogueTarget[]> {
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

/** Resolve the given targets to their live catalogue entries (missing = no longer bookable). */
export async function resolveCatalogueTargets(keys: Array<{ targetType: string; targetId: string }>) {
  const wanted = new Set(keys.map((k) => `${k.targetType}:${k.targetId}`));
  const all = await listBookableTargets();
  const map = new Map<string, CatalogueTarget>();
  for (const t of all) {
    const k = `${t.targetType}:${t.targetId}`;
    if (wanted.has(k)) map.set(k, t);
  }
  return map;
}

// ── Admin: the rate-card grid ───────────────────────────────────────────────────

export async function listRateCardGrid() {
  const [targets, cards] = await Promise.all([listBookableTargets(), prisma.campaignRateCard.findMany()]);
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
        cards: own.map((c) => ({ id: c.id, format: c.format, pricePaise: c.pricePaise, active: c.active })),
      };
    })
    .sort((a, b) => (b.followers ?? 0) - (a.followers ?? 0) || a.name.localeCompare(b.name));
}

export async function upsertRateCards(input: CampaignRateCardUpsertInput, staffId: string) {
  const targets = await resolveCatalogueTargets(input.cards);
  let upserted = 0;
  let deleted = 0;
  await prisma.$transaction(async (tx) => {
    for (const c of input.cards) {
      const t = targets.get(`${c.targetType}:${c.targetId}`);
      if (!t) throw new AppError(400, "UNKNOWN_ACCOUNT", "One of the accounts is not connected any more. Refresh the page.");
      if (!(PLATFORM_FORMATS[t.platform] as readonly CampaignFormat[]).includes(c.format)) {
        throw new AppError(400, "FORMAT_NOT_SUPPORTED", `${t.platform} has no ${c.format} format.`);
      }
      const where = { targetType_targetId_format: { targetType: c.targetType, targetId: c.targetId, format: c.format } };
      if (c.pricePaise == null) {
        const r = await tx.campaignRateCard.deleteMany({ where: { targetType: c.targetType, targetId: c.targetId, format: c.format } });
        deleted += r.count;
        continue;
      }
      await tx.campaignRateCard.upsert({
        where,
        create: {
          targetType: c.targetType,
          targetId: c.targetId,
          platform: t.platform,
          format: c.format,
          pricePaise: c.pricePaise,
          active: c.active ?? true,
          category: c.category ?? null,
          updatedById: staffId,
        },
        update: {
          pricePaise: c.pricePaise,
          active: c.active ?? true,
          ...(c.category !== undefined ? { category: c.category } : {}),
          updatedById: staffId,
        },
      });
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
  offers: Array<{ rateCardId: string; format: CampaignFormat; pricePaise: number }>;
}

/** Bookable accounts with at least one active price. Only the listed fields leave the server. */
export async function getCatalogue(): Promise<CatalogueEntry[]> {
  return catalogueMemo.memo("all", async () => {
    const [targets, cards] = await Promise.all([
      listBookableTargets(),
      prisma.campaignRateCard.findMany({ where: { active: true } }),
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
        offers: own
          .filter((c) => (PLATFORM_FORMATS[t.platform] as readonly string[]).includes(c.format))
          .map((c) => ({ rateCardId: c.id, format: c.format as CampaignFormat, pricePaise: c.pricePaise })),
      });
    }
    return out.sort((a, b) => (b.followers ?? 0) - (a.followers ?? 0) || a.name.localeCompare(b.name));
  });
}
