/**
 * Backfill: enrich link_content with caption/title for already-submitted posts.
 *
 * Stage 1 of the link-entity-search feature. The 6h social-insights cron only
 * enriches links it polls going forward; this script back-fills the historical
 * YouTube links so the entity-search corpus starts populated.
 *
 * DRY-RUN BY DEFAULT — pass --apply to actually write link_content rows.
 *
 * Usage:
 *   cd packages/db && npx tsx ../../scripts/enrich-link-content.ts            # dry-run, counts only
 *   cd packages/db && npx tsx ../../scripts/enrich-link-content.ts --apply    # fetch + upsert
 *
 * Scope: distinct YouTube report_links (isScheduled=false, url present). For each
 * distinct canonicalKey NOT already present in link_content with status='ok', we
 * fetch the snippet via the YouTube provider and upsert title/caption keyed on the
 * canonicalKey (one row per unique post).
 *
 * Requires YOUTUBE_API_KEY to actually fetch. Without it, the dry-run still reports
 * counts (how many keys would be enriched) and exits 0 without fetching.
 *
 * Classification reuses the SAME canonicalKey() the cron + dedupe use — imported
 * from @dashmani/shared (NOT reimplemented) so the keys match byte-for-byte.
 */

import { prisma } from "@dashmani/db";
import { canonicalKey, extractYouTubeVideoId } from "@dashmani/shared";
import { youTubeProvider } from "../apps/api/src/services/social-insights/youtube.provider";
import { upsertLinkContent } from "../apps/api/src/services/link-content.service";
import type { InsightTarget } from "../apps/api/src/services/social-insights/types";

const APPLY = process.argv.includes("--apply");

async function main() {
  console.log(`\n=== enrich-link-content (${APPLY ? "APPLY" : "DRY-RUN"}) ===\n`);

  // 1. Pull all candidate YouTube links (non-scheduled, with a URL).
  const rows = await prisma.reportLink.findMany({
    where: {
      platform: { equals: "youtube", mode: "insensitive" },
      url: { not: null },
      isScheduled: false,
    },
    select: {
      id: true,
      url: true,
      report: { select: { employeeId: true, date: true } },
    },
  });
  console.log(`Candidate YouTube report_links: ${rows.length}`);

  // 2. Collapse to distinct canonicalKey. Keep one representative InsightTarget per key
  //    (the YouTube provider only needs a parseable video URL per key).
  const byKey = new Map<string, InsightTarget>();
  let unparseable = 0;
  for (const row of rows) {
    if (!row.url) continue;
    const url = row.url.trim();
    const key = canonicalKey(url);
    if (!key || !key.startsWith("yt:")) {
      unparseable++;
      continue;
    }
    if (byKey.has(key)) continue;
    const targetId = extractYouTubeVideoId(url);
    if (!targetId) {
      unparseable++;
      continue;
    }
    byKey.set(key, {
      linkId: key, // use the canonicalKey as the map key for fetchBatch results
      url,
      urlNormalized: url.toLowerCase(),
      targetId,
      employeeId: row.report.employeeId,
      reportDate: row.report.date,
    });
  }
  console.log(`Distinct YouTube canonicalKeys: ${byKey.size} (skipped ${unparseable} unparseable/non-yt)`);

  // 3. Find which keys are already enriched (status='ok'). Those are skipped.
  const allKeys = [...byKey.keys()];
  const existing = await prisma.linkContent.findMany({
    where: { canonicalKey: { in: allKeys } },
    select: { canonicalKey: true, status: true },
  });
  const enrichedOk = new Set(existing.filter((e) => e.status === "ok").map((e) => e.canonicalKey));
  const toEnrich = allKeys.filter((k) => !enrichedOk.has(k));
  console.log(`Already enriched (status=ok): ${enrichedOk.size}`);
  console.log(`Would enrich / to enrich: ${toEnrich.length}`);

  if (toEnrich.length === 0) {
    console.log(`\nNothing to do.\n`);
    await prisma.$disconnect();
    return;
  }

  // 4. DRY-RUN: report only, write nothing.
  if (!APPLY) {
    console.log(`\nDRY-RUN — no rows written. Re-run with --apply to fetch + upsert.\n`);
    await prisma.$disconnect();
    return;
  }

  // 5. APPLY path requires the API key.
  if (!process.env.YOUTUBE_API_KEY) {
    console.log(`\nYOUTUBE_API_KEY is not set — cannot fetch snippets. Set it and re-run with --apply.\n`);
    await prisma.$disconnect();
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
      results = (await youTubeProvider.fetchBatch(batch)) as typeof results;
    } catch (err) {
      console.error(`  batch ${i}-${i + batch.length} fetch failed:`, err);
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
          console.error(`  upsert failed for ${t.linkId}:`, err);
          errors++;
        }
      } else if (r.status === "not_found") {
        // Record the not_found so we don't re-fetch a deleted/private video every run.
        try {
          await upsertLinkContent({ canonicalKey: t.linkId, status: "not_found" });
          notFound++;
        } catch (err) {
          console.error(`  upsert(not_found) failed for ${t.linkId}:`, err);
          errors++;
        }
      } else {
        errors++;
      }
    }
    console.log(`  progress: ${Math.min(i + BATCH, targets.length)}/${targets.length}`);
  }

  console.log(`\n=== Summary ===`);
  console.log(`Distinct keys found:   ${byKey.size}`);
  console.log(`Already enriched:      ${enrichedOk.size}`);
  console.log(`Enriched this run:     ${enriched}`);
  console.log(`Marked not_found:      ${notFound}`);
  console.log(`Errors:                ${errors}\n`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("enrich-link-content failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
