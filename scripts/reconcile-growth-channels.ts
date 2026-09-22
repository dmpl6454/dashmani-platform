/**
 * Seed + reconcile the YouTube and Snapchat channels behind Account Growth.
 *
 * Run from packages/db so Prisma picks up its .env. ⚠️ YOUTUBE_API_KEY lives in
 * apps/api/.env, which this working directory does NOT load — without passing it through,
 * every YouTube channel silently reports "did not resolve":
 *
 *   cd packages/db
 *   env YOUTUBE_API_KEY=$(grep ^YOUTUBE_API_KEY ../../apps/api/.env | cut -d= -f2-) \
 *     npx tsx ../../scripts/reconcile-growth-channels.ts                      # dry run
 *   env YOUTUBE_API_KEY=$(grep ^YOUTUBE_API_KEY ../../apps/api/.env | cut -d= -f2-) \
 *     npx tsx ../../scripts/reconcile-growth-channels.ts --apply --confirm-prod
 *
 * What it does, and why each part is needed (all live-verified 2026-09-22):
 *
 *  1. YOUTUBE — 15 of the 16 requested channels already exist and already sync via the
 *     official API. This resolves every requested channel to its permanent UC… id, matches
 *     existing rows by that id, creates only what is genuinely missing, and corrects
 *     display names that are demonstrably wrong (prod has `Crazy4Bollywood` titled
 *     "Movified Tamil" and `TotalFilmi` titled "Bollywood Standard").
 *
 *  2. SNAPCHAT — the `/p/<uuid>` page shape these rows were built on is RETIRED (every
 *     stored URL 404s), so four accounts are frozen on August figures. This repoints them
 *     at their live `@handle` and adds the rest of the requested profiles.
 *
 * ⚠️ NON-DESTRUCTIVE. It never deletes a row and never archives one. `report_links`
 * references these accounts, and a removed channel is expressed as status=ARCHIVED through
 * the UI, not by deletion here. Handle rewrites are by id, so no FK is touched.
 *
 * ⚠️ Every channel is RESOLVED LIVE before it is written. A handle that does not resolve is
 * reported and skipped, never stored as a dead row — that is how `bollywodpaps` (a missing
 * "o", hiding the largest Snapchat account in the estate) was caught in the first place.
 */

import { prisma } from "@dashmani/db";
import { resolveYouTubeChannel } from "../apps/api/src/services/social-insights/youtube-followers";
import { scrapeSnapchatProfile, snapchatProfileUrl } from "../apps/api/src/services/social-insights/snapchat-profile";
import { istMidnight, todayIST } from "@dashmani/shared";

const APPLY = process.argv.includes("--apply");
const CONFIRM_PROD = process.argv.includes("--confirm-prod");

const YOUTUBE: Array<{ name: string; url: string }> = [
  { name: "Inde News", url: "https://www.youtube.com/@Inde-News" },
  { name: "Crazy 4 Bollywood", url: "https://www.youtube.com/@Crazy4Bollywood" },
  { name: "Crazy 4 Tv", url: "https://www.youtube.com/@Crazy4Tv" },
  { name: "Bollywood Reporter", url: "https://www.youtube.com/channel/UCpOzkHJlASfeA6NoBZ3h3hQ" },
  { name: "Movified", url: "https://www.youtube.com/@Movified" },
  { name: "Bollywood Society", url: "https://www.youtube.com/@BollywoodSocietyy" },
  { name: "Total Filmii", url: "https://www.youtube.com/@TotalFilmi" },
  { name: "Purvanchal Live", url: "https://www.youtube.com/channel/UCXH2QI6TtT0q2gqBQktkTSQ" },
  { name: "Telly Drama", url: "https://www.youtube.com/@TellyDrama" },
  { name: "Paparazzi Shorts", url: "https://www.youtube.com/channel/UCgKpqBllzEH_T4L221tdvdg" },
  { name: "Bollywood Paparazzi", url: "https://www.youtube.com/@BollywoodPaparazzii" },
  { name: "Bollywood Reels", url: "https://www.youtube.com/@BollywoodReels_" },
  { name: "Marathi Entertainment", url: "https://www.youtube.com/@MarathiEntertainment1" },
  { name: "Movie Review Preview", url: "https://www.youtube.com/channel/UCfYb-i0xqR88A8LQcyerm4g" },
  { name: "Bollywood Dazzle", url: "https://www.youtube.com/@BollywoodDazzle" },
  { name: "Bollywood Standard", url: "https://www.youtube.com/@BollywoodStandard1" },
];

/**
 * ⚠️ `bollywoodpaps` carries the owner's typo corrected (he wrote `bollywodpaps`, which
 * 404s; the corrected spelling resolves to "Bollywood Paparazzi", 396,100 subscribers —
 * the largest Snapchat account in the estate).
 *
 * `MovieReviewhub` is retained EXACTLY as supplied even though it 404s on every spelling
 * tried, per the owner's instruction to keep the remaining ones and correct them later.
 * It will be reported as unresolved on every run until its real handle is supplied; it is
 * never written as a dead row.
 */
const SNAPCHAT: string[] = [
  // the owner's first list — his own profiles (badge 1 on 13 of 14)
  "bollywoodchroni", "bollywodsociety", "movified_bolly", "sudhanshu6454", "intlfashion",
  "telly_drama", "totalfilmi", "publicpov", "standupcomedi", "grwceleb", "most_expensiv",
  "amazinsurprisin", "garimasgoodlyf", "bollywoodpaps", "paparazzze",
  // the second list — monitored accounts (badge 0 on all 21)
  "JustBollywood", "crazy4bolly", "bollydazzle", "glitz.in", "pappfeed", "pappshq",
  "luxelyfstyle", "entnewz", "bollytimess", "papscentral", "bollymasalaa", "papsgrid",
  "bollyreporterr", "bollymirror", "viralpapss", "papana.p", "starssnapped",
  "paparazzireel", "Bollywoodpop", "MovieReviewhub", "paparazzinews",
];

/**
 * Existing rows whose stored display name does NOT equal the platform's current title, so
 * neither the handle nor the name would match them.
 *
 * ⚠️ Without this the script CREATES A DUPLICATE: prod stores "Moviefied Bollywood" (with
 * an "e") while Snapchat's live title for @movified_bolly is "Movified Bollywood" (without).
 * The stale row would stay ACTIVE on 129,800 August followers and the new row would appear
 * beside it — the same channel twice on the board, disagreeing.
 *
 * Keyed by the handle we are adding -> the stored display name to adopt.
 */
const SNAPCHAT_ALIASES: Record<string, string> = {
  movified_bolly: "moviefied bollywood",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Action = { kind: "create" | "update" | "skip"; platform: string; handle: string; detail: string };
const actions: Action[] = [];

async function platformId(slug: string): Promise<string> {
  const p = await prisma.platform.findUnique({ where: { slug }, select: { id: true } });
  if (!p) throw new Error(`Platform "${slug}" is not seeded — run db:seed first.`);
  return p.id;
}

/**
 * Anchor a channel's growth history at the value this run measured.
 *
 * ⚠️ WHY THIS EXISTS. This script wrote follower_count + last_synced_at straight onto the
 * row and never created a snapshot, so a channel it added or refreshed stored a fresh
 * count that NEVER entered account_growth_snapshots. Measured on prod after the last run,
 * 28 of 35 Snapchat rows had a current follower count and zero snapshots — their Change
 * column had nothing to compute from and the board read as broken rather than new.
 *
 * ⚠️ IST midnight, matching persistFollowerCount, so the (accountId, date) key is
 * idempotent whichever writer gets there first.
 */
async function anchorSnapshot(
  accountId: string,
  followers: number | null | undefined,
  source: string,
  totalViews?: number | null,
) {
  if (followers == null || followers <= 0) return;
  const day = istMidnight(todayIST());
  try {
    await prisma.accountGrowthSnapshot.upsert({
      where: { accountId_date: { accountId, date: day } },
      create: {
        accountId, date: day, followerCount: followers, source,
        ...(totalViews != null ? { totalViews: BigInt(totalViews) } : {}),
      },
      update: {
        followerCount: followers,
        ...(totalViews != null ? { totalViews: BigInt(totalViews) } : {}),
      },
    });
  } catch (e) {
    console.warn(`    ! could not anchor history for ${accountId}:`, e);
  }
}

async function doYouTube() {
  console.log("\n=== YOUTUBE ===");
  const pid = await platformId("youtube");
  const existing = await prisma.socialAccount.findMany({
    where: { platformId: pid },
    select: { id: true, handle: true, displayName: true, profileUrl: true, status: true },
  });

  // Index existing rows by every id we can derive from what they store.
  const byChannelId = new Map<string, (typeof existing)[number]>();
  const byHandle = new Map<string, (typeof existing)[number]>();
  for (const a of existing) {
    byHandle.set(a.handle.replace(/^@/, "").toLowerCase(), a);
    const fromUrl = (a.profileUrl ?? "").match(/\/channel\/(UC[\w-]{22})/)?.[1];
    if (fromUrl) byChannelId.set(fromUrl, a);
    if (/^UC[\w-]{22}$/.test(a.handle)) byChannelId.set(a.handle, a);
  }

  for (const want of YOUTUBE) {
    const resolved = await resolveYouTubeChannel(want.url);
    if (!resolved) {
      actions.push({ kind: "skip", platform: "youtube", handle: want.name, detail: "did not resolve — NOT stored" });
      console.log(`  ✗ ${want.name.padEnd(24)} did not resolve`);
      continue;
    }
    const handleFromUrl = want.url.match(/\/@([^/?#]+)/)?.[1] ?? resolved.channelId;
    const hit =
      byChannelId.get(resolved.channelId) ??
      byHandle.get(handleFromUrl.toLowerCase()) ??
      byHandle.get(resolved.channelId.toLowerCase());

    const data = {
      displayName: resolved.title,
      profileUrl: `https://www.youtube.com/channel/${resolved.channelId}`,
      followersPrecision: resolved.subscriberPrecision,
      ...(resolved.subscribers != null
        ? { followerCount: resolved.subscribers, syncSource: "api", lastSyncedAt: new Date() }
        : {}),
      ...(resolved.totalViews != null ? { totalViews: BigInt(resolved.totalViews) } : {}),
      ...(resolved.videoCount != null ? { videoCount: resolved.videoCount } : {}),
      metricsError: null,
      metricsFetchedAt: new Date(),
    };

    if (hit) {
      const renamed = hit.displayName !== resolved.title;
      const detail = renamed
        ? `name "${hit.displayName}" → "${resolved.title}" (corrected from the API)`
        : `refreshed (${resolved.subscribers?.toLocaleString() ?? "—"} subs, ${resolved.totalViews?.toLocaleString() ?? "—"} views)`;
      actions.push({ kind: "update", platform: "youtube", handle: hit.handle, detail });
      console.log(`  ↻ ${hit.handle.padEnd(26)} ${detail}`);
      if (APPLY) {
        await prisma.socialAccount.update({ where: { id: hit.id }, data });
        await anchorSnapshot(hit.id, resolved.subscribers, "api", resolved.totalViews);
      }
    } else {
      const handle = handleFromUrl;
      actions.push({
        kind: "create",
        platform: "youtube",
        handle,
        detail: `${resolved.title} — ${resolved.subscribers?.toLocaleString() ?? "—"} subs`,
      });
      console.log(`  + ${handle.padEnd(26)} ${resolved.title} (${resolved.subscribers?.toLocaleString() ?? "—"})`);
      if (APPLY) {
        const made = await prisma.socialAccount.create({
          data: { ...data, handle, platformId: pid, status: "ACTIVE" },
        });
        await anchorSnapshot(made.id, resolved.subscribers, "api", resolved.totalViews);
      }
    }
  }
}

async function doSnapchat() {
  console.log("\n=== SNAPCHAT ===");
  const pid = await platformId("snapchat");
  const existing = await prisma.socialAccount.findMany({
    where: { platformId: pid },
    select: { id: true, handle: true, displayName: true, profileUrl: true },
  });
  const byHandle = new Map(existing.map((a) => [a.handle.toLowerCase(), a]));
  // Match the four rows whose `handle` is a display name, not a username, by their title.
  const byName = new Map(existing.map((a) => [a.displayName.trim().toLowerCase(), a]));
  /** Which pre-existing rows a requested handle claimed — anything left over is reported. */
  const matched = new Set<string>();

  for (const handle of SNAPCHAT) {
    const profile = await scrapeSnapchatProfile(handle);
    await sleep(900); // polite: the whole list is ~35 requests

    if (!profile.ok) {
      actions.push({ kind: "skip", platform: "snapchat", handle, detail: profile.error ?? "unresolved" });
      console.log(`  ✗ ${handle.padEnd(22)} ${profile.error}`);
      continue;
    }

    const hit =
      byHandle.get(handle.toLowerCase()) ??
      (profile.displayName ? byName.get(profile.displayName.trim().toLowerCase()) : undefined) ??
      (SNAPCHAT_ALIASES[handle] ? byName.get(SNAPCHAT_ALIASES[handle]) : undefined);
    if (hit) {
      // ⚠️ CLAIM IT. The indexes are built once, so without this a second requested handle
      // whose live title happens to match the same stored row would claim it AGAIN and
      // rewrite its handle a second time — one channel silently untracked, and the surviving
      // row (which report_links.accountId points at) carrying a mix of two channels' figures.
      matched.add(hit.id);
      byHandle.delete(hit.handle.toLowerCase());
      byName.delete(hit.displayName.trim().toLowerCase());
    }

    const data = {
      displayName: profile.displayName ?? handle,
      // ⚠️ Repoint at the LIVE page shape. The stored /p/<uuid> and /t/<code> URLs all 404.
      profileUrl: snapchatProfileUrl(handle).replace("?locale=en-US", ""),
      recentViews: profile.recentViews == null ? null : BigInt(profile.recentViews),
      recentViewsCovered: profile.viewsCovered,
      recentPostsSeen: profile.postsSeen,
      metricsError: null,
      // A successful parse IS a successful fetch. Stamping this is what stops a profile
      // that withholds its follower count from rendering as "Manual" (hand-entered).
      metricsFetchedAt: new Date(),
      // Only write a count Snapchat actually published. 7 of 34 profiles withhold theirs,
      // and a stored 0 would render as a real "no followers".
      ...(profile.followers != null
        ? { followerCount: profile.followers, syncSource: "scraper", lastSyncedAt: new Date() }
        : {}),
    };

    if (hit) {
      const bits: string[] = [];
      if (hit.handle.toLowerCase() !== handle.toLowerCase()) bits.push(`handle "${hit.handle}" → "${handle}"`);
      if (/\/p\/|\/t\//.test(hit.profileUrl ?? "")) bits.push("repointed off the retired /p/ URL");
      bits.push(profile.followers != null ? `${profile.followers.toLocaleString()} followers` : "followers withheld by Snapchat");
      const detail = bits.join("; ");
      actions.push({ kind: "update", platform: "snapchat", handle, detail });
      console.log(`  ↻ ${handle.padEnd(22)} ${detail}`);
      if (APPLY) {
        await prisma.socialAccount.update({ where: { id: hit.id }, data: { ...data, handle } });
        await anchorSnapshot(hit.id, profile.followers, "scraper");
      }
    } else {
      const detail = `${profile.displayName} — ${
        profile.followers != null ? `${profile.followers.toLocaleString()} followers` : "followers withheld"
      }, views ${profile.viewsCovered}/${profile.postsSeen}`;
      actions.push({ kind: "create", platform: "snapchat", handle, detail });
      console.log(`  + ${handle.padEnd(22)} ${detail}`);
      if (APPLY) {
        const made = await prisma.socialAccount.create({
          data: { ...data, handle, platformId: pid, status: "ACTIVE" },
        });
        await anchorSnapshot(made.id, profile.followers, "scraper");
      }
    }
  }

  // ⚠️ Anything already on this platform that no requested handle claimed is a POSSIBLE
  // DUPLICATE — a renamed channel we failed to match, which would now sit on the board
  // twice with two different figures. Report it loudly; never silently archive or delete,
  // because report_links references these rows and the call is the owner's to make.
  const orphans = existing.filter((a) => !matched.has(a.id));
  if (orphans.length > 0) {
    console.log(`  ⚠ ${orphans.length} existing Snapchat row(s) matched no requested handle:`);
    for (const o of orphans) {
      console.log(`      "${o.handle}" (${o.displayName}) — check whether this duplicates one above`);
      actions.push({ kind: "skip", platform: "snapchat", handle: o.handle, detail: "pre-existing row, unmatched — possible duplicate" });
    }
  }
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const looksProd = !/localhost|127\.0\.0\.1/.test(url);
  if (APPLY && looksProd && !CONFIRM_PROD) {
    console.error("Refusing to --apply against a non-local database without --confirm-prod.");
    process.exit(1);
  }
  console.log(APPLY ? "MODE: APPLY (writing)" : "MODE: DRY RUN (nothing is written)");

  await doYouTube();
  await doSnapchat();

  const by = (k: Action["kind"]) => actions.filter((a) => a.kind === k);
  console.log("\n=== SUMMARY ===");
  console.log(`  create : ${by("create").length}`);
  console.log(`  update : ${by("update").length}`);
  console.log(`  skipped: ${by("skip").length}`);
  for (const a of by("skip")) console.log(`     ! ${a.platform}/${a.handle} — ${a.detail}`);
  if (!APPLY) console.log("\nRe-run with --apply (and --confirm-prod against prod) to write.");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
