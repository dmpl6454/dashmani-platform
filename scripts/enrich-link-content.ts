/**
 * Backfill: enrich link_content with caption/title for already-submitted posts.
 *
 * Stage 1 of the link-entity-search feature. The 6h social-insights cron only
 * enriches links it polls going forward; this script back-fills the historical
 * links so the entity-search corpus starts populated.
 *
 * PROVIDER-AGNOSTIC: loops every supported provider (getSupportedSlugs() —
 * currently youtube, instagram, facebook) and uses each provider's own
 * extractTargetId() + fetchBatch(). Mirrors the cron exactly, so adding a new
 * provider needs no change here. (Originally YouTube-only; generalized 2026-06-23
 * when IG/FB went live.)
 *
 * DRY-RUN BY DEFAULT — pass --apply to actually write link_content rows.
 * Optionally restrict to one platform with --platform=instagram.
 *
 * Usage:
 *   cd packages/db && npx tsx ../../scripts/enrich-link-content.ts                      # dry-run, all platforms
 *   cd packages/db && npx tsx ../../scripts/enrich-link-content.ts --platform=instagram # dry-run, IG only
 *   cd packages/db && npx tsx ../../scripts/enrich-link-content.ts --apply              # fetch + upsert, all
 *   cd packages/db && npx tsx ../../scripts/enrich-link-content.ts --apply --platform=facebook
 *
 * Scope per platform: distinct report_links (isScheduled=false, url present) whose
 * canonicalKey the provider can extract a targetId from. For each distinct
 * canonicalKey NOT already enriched (status='ok') we call the provider's fetchBatch
 * and upsert title/caption keyed on canonicalKey (one row per unique post).
 *
 * Requires the relevant API credential to actually fetch:
 *   - youtube  → YOUTUBE_API_KEY
 *   - instagram/facebook → META_SYSTEM_USER_TOKEN
 * A provider whose isSupported() is false is skipped with a clear message; the
 * dry-run still reports counts for it (how many keys WOULD enrich).
 *
 * Classification reuses the SAME canonicalKey() the cron + dedupe use — imported
 * from @dashmani/shared (NOT reimplemented) so the keys match byte-for-byte.
 */

import { prisma } from "@dashmani/db";
import { canonicalKey } from "@dashmani/shared";
import { getSupportedSlugs, getProvider } from "../apps/api/src/services/social-insights";
import { upsertLinkContent } from "../apps/api/src/services/link-content.service";
import type { InsightTarget } from "../apps/api/src/services/social-insights/types";

const APPLY = process.argv.includes("--apply");
const PLATFORM_ARG = process.argv.find((a) => a.startsWith("--platform="))?.split("=")[1]?.toLowerCase();

// canonicalKey prefix per slug — used only to keep each provider's candidate set
// scoped to links it can actually handle. (Facebook opaque /share/ keys fall
// through to a full-url key, so they won't match "fb:" and are correctly skipped.)
const KEY_PREFIX: Record<string, string> = {
  youtube: "yt:",
  instagram: "ig:",
  facebook: "fb:",
};

async function enrichPlatform(slug: string): Promise<void> {
  const provider = getProvider(slug);
  if (!provider) {
    console.log(`\n[${slug}] no provider registered — skipping.`);
    return;
  }

  console.log(`\n=== [${slug}] enrich-link-content (${APPLY ? "APPLY" : "DRY-RUN"}) ===`);

  // 1. Pull candidate links for this platform. Classify by canonicalKey prefix
  //    (NOT the dirty platform column) — but pre-filter on the column to keep the
  //    query bounded, then the canonicalKey check is the exact arbiter below.
  const rows = await prisma.reportLink.findMany({
    where: {
      platform: { equals: slug, mode: "insensitive" },
      url: { not: null },
      isScheduled: false,
    },
    select: {
      id: true,
      url: true,
      report: { select: { employeeId: true, date: true } },
    },
  });
  console.log(`[${slug}] candidate report_links: ${rows.length}`);

  // 2. Collapse to distinct canonicalKey; build one InsightTarget per key via the
  //    provider's own extractTargetId (videoId / shortcode / numeric post id).
  const prefix = KEY_PREFIX[slug] ?? "";
  const byKey = new Map<string, InsightTarget>();
  let unparseable = 0;
  for (const row of rows) {
    if (!row.url) continue;
    const url = row.url.trim();
    const key = canonicalKey(url);
    if (!key || (prefix && !key.startsWith(prefix))) {
      unparseable++;
      continue;
    }
    if (byKey.has(key)) continue;
    const targetId = provider.extractTargetId(url);
    if (!targetId) {
      unparseable++;
      continue;
    }
    byKey.set(key, {
      linkId: key, // use canonicalKey as the fetchBatch result key
      url,
      urlNormalized: url.toLowerCase(),
      targetId,
      employeeId: row.report.employeeId,
      reportDate: row.report.date,
    });
  }
  console.log(`[${slug}] distinct canonicalKeys: ${byKey.size} (skipped ${unparseable} unparseable/opaque)`);

  // 3. Which keys are already enriched (status='ok')? Skip those.
  const allKeys = [...byKey.keys()];
  const existing = allKeys.length
    ? await prisma.linkContent.findMany({
        where: { canonicalKey: { in: allKeys } },
        select: { canonicalKey: true, status: true },
      })
    : [];
  const enrichedOk = new Set(existing.filter((e) => e.status === "ok").map((e) => e.canonicalKey));
  const toEnrich = allKeys.filter((k) => !enrichedOk.has(k));
  console.log(`[${slug}] already enriched (status=ok): ${enrichedOk.size}`);
  console.log(`[${slug}] would enrich / to enrich: ${toEnrich.length}`);

  if (toEnrich.length === 0) {
    console.log(`[${slug}] nothing to do.`);
    return;
  }

  // 4. DRY-RUN: report only.
  if (!APPLY) {
    console.log(`[${slug}] DRY-RUN — no rows written.`);
    return;
  }

  // 5. APPLY requires the provider to be configured (its credential present).
  if (!provider.isSupported()) {
    console.log(`[${slug}] provider not configured (missing credential) — cannot fetch. Skipping write.`);
    return;
  }

  // 6. Fetch in batches via the provider, then upsert.
  const targets = toEnrich.map((k) => byKey.get(k)!).filter(Boolean);
  let enriched = 0;
  let notFound = 0;
  let errors = 0;

  const BATCH = 50;
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    let results: Map<string, { ok: boolean; status: string; title?: string | null; caption?: string | null }>;
    try {
      results = (await provider.fetchBatch(batch)) as typeof results;
    } catch (err) {
      console.error(`  [${slug}] batch ${i}-${i + batch.length} fetch failed:`, err);
      errors += batch.length;
      continue;
    }

    for (const t of batch) {
      const r = results.get(t.linkId); // linkId === canonicalKey here
      if (!r) {
        errors++;
        continue;
      }
      if (r.ok && (r.title != null || r.caption != null)) {
        try {
          await upsertLinkContent({
            canonicalKey: t.linkId,
            title: r.title ?? null,
            caption: r.caption ?? null,
            status: "ok",
          });
          enriched++;
        } catch (err) {
          console.error(`  [${slug}] upsert failed for ${t.linkId}:`, err);
          errors++;
        }
      } else if (r.status === "not_found") {
        // Record not_found so we don't re-fetch a deleted/private/unmanaged post every run.
        try {
          await upsertLinkContent({ canonicalKey: t.linkId, status: "not_found" });
          notFound++;
        } catch (err) {
          console.error(`  [${slug}] upsert(not_found) failed for ${t.linkId}:`, err);
          errors++;
        }
      } else {
        errors++;
      }
    }
    console.log(`  [${slug}] progress: ${Math.min(i + BATCH, targets.length)}/${targets.length}`);
  }

  console.log(`[${slug}] === summary === distinct=${byKey.size} alreadyOk=${enrichedOk.size} enriched=${enriched} notFound=${notFound} errors=${errors}`);
}

async function main() {
  const slugs = getSupportedSlugs().filter((s) => !PLATFORM_ARG || s === PLATFORM_ARG);
  console.log(`\nenrich-link-content — platforms: ${slugs.join(", ") || "(none supported)"}  mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);
  if (PLATFORM_ARG && !slugs.length) {
    console.log(`Requested platform "${PLATFORM_ARG}" is not a supported slug. Supported: ${getSupportedSlugs().join(", ")}`);
  }
  for (const slug of slugs) {
    await enrichPlatform(slug);
  }
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("enrich-link-content failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
