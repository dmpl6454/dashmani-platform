/**
 * One-off backfill: capture Instagram captions for posts on accounts we do NOT
 * administer, via the Graph API business_discovery.media edge.
 *
 * WHY THIS EXISTS
 * ---------------
 * The 6h social-insights harvest cron reads captions only from the ~38 IG
 * accounts we administer (owned /media). But ~30k submitted IG links point at
 * ~63 EXTERNAL accounts (paparazzi/news pages) we don't administer — their
 * captions were unreachable, so those links weren't name-searchable.
 *
 * business_discovery (the same edge we already use for follower counts) CAN read
 * any public business/creator account's recent media — caption + permalink +
 * timestamp — and the permalink's shortcode matches our `ig:<shortcode>`
 * canonicalKey byte-for-byte (verified live 2026-06-27: 38/50 of one account's
 * recent posts matched submitted links). The platform's entire link corpus is
 * only ~11 weeks old, so paging each account a few dozen pages reaches its full
 * in-corpus history cheaply. This is the FREE path — no paid scraper needed.
 *
 * WHAT IT DOES
 * ------------
 * 1. Find the distinct IG accounts that own NOT-yet-captioned submitted links
 *    (status != 'ok'), with their handles.
 * 2. Page each account's business_discovery.media newest-first.
 * 3. For every returned post whose `ig:<shortcode>` key MATCHES a submitted link
 *    we don't already have a caption for, upsert link_content (status='ok').
 *    Posts nobody submitted are ignored (we only store what's referenced).
 *
 * SAFETY
 * ------
 * - DRY-RUN BY DEFAULT. Pass --apply to write.
 * - Fail-open: fetchPublicInstagramCaptions never throws; rate-limit → partial.
 * - Polite: 300ms between pages (shared ~200-call/hr Meta budget). Run it in the
 *   social-insights cron's idle window so it never contends with the live sweep.
 * - Idempotent: skips keys already status='ok'; re-running only fills the rest.
 * - Reuses canonicalKey() + upsertLinkContent() — keys match everything else.
 * - Requires META_SYSTEM_USER_TOKEN in env (load apps/api/.env before running).
 *
 * Usage (from packages/db so DATABASE_URL loads; source the API env for the token):
 *   cd packages/db && set -a && . ../../apps/api/.env && set +a
 *   npx tsx ../../scripts/backfill-ig-captions.ts                 # dry-run
 *   npx tsx ../../scripts/backfill-ig-captions.ts --apply         # write
 *   npx tsx ../../scripts/backfill-ig-captions.ts --apply --max-pages=60
 *   npx tsx ../../scripts/backfill-ig-captions.ts --apply --handle=paparazzzee  # one account
 */

import { prisma } from "@dashmani/db";
import { canonicalKey } from "@dashmani/shared";
import { fetchPublicInstagramCaptions } from "../apps/api/src/services/social-insights/meta-followers";
import { upsertLinkContent } from "../apps/api/src/services/link-content.service";

const APPLY = process.argv.includes("--apply");
const MAX_PAGES = Number(process.argv.find((a) => a.startsWith("--max-pages="))?.split("=")[1]) || 40;
const ONLY_HANDLE = process.argv.find((a) => a.startsWith("--handle="))?.split("=")[1]?.toLowerCase();

async function main() {
  console.log(`\nbackfill-ig-captions — mode: ${APPLY ? "APPLY" : "DRY-RUN"}  maxPages/account: ${MAX_PAGES}`);

  // 1. Distinct IG accounts owning at least one not-yet-captioned submitted link.
  //    We bucket by URL host (instagram.com) — NOT the dirty platform column — and
  //    derive each link's ig:<shortcode> key the same way canonicalKey does, then
  //    check link_content for a status='ok' row. An account is "in the gap" if it
  //    has >=1 submitted IG link with no ok caption.
  const igLinks = await prisma.reportLink.findMany({
    where: {
      isScheduled: false,
      url: { contains: "instagram.com", mode: "insensitive" },
    },
    select: {
      url: true,
      account: { select: { id: true, handle: true, displayName: true } },
    },
  });
  console.log(`IG submitted links (host-matched): ${igLinks.length}`);

  // Build: key → true (submitted), and account-handle → set of its submitted keys.
  const submittedKeys = new Set<string>();
  const byHandle = new Map<string, { handle: string; display: string; keys: Set<string> }>();
  for (const l of igLinks) {
    if (!l.url) continue;
    const key = canonicalKey(l.url);
    if (!key || !key.startsWith("ig:")) continue;
    submittedKeys.add(key);
    const handle = (l.account?.handle || "").replace(/^@/, "").trim();
    if (!handle) continue;
    const hk = handle.toLowerCase();
    if (!byHandle.has(hk)) byHandle.set(hk, { handle, display: l.account?.displayName || handle, keys: new Set() });
    byHandle.get(hk)!.keys.add(key);
  }

  // 2. Which submitted keys already have an OK caption? Skip accounts fully covered.
  const allKeys = [...submittedKeys];
  const okRows = allKeys.length
    ? await prisma.linkContent.findMany({
        where: { canonicalKey: { in: allKeys }, status: "ok" },
        select: { canonicalKey: true },
      })
    : [];
  const okSet = new Set(okRows.map((r) => r.canonicalKey));

  // Gap handles = handles with >=1 submitted key not yet ok.
  let gapHandles = [...byHandle.values()]
    .map((h) => ({ ...h, missing: [...h.keys].filter((k) => !okSet.has(k)) }))
    .filter((h) => h.missing.length > 0)
    .sort((a, b) => b.missing.length - a.missing.length);

  if (ONLY_HANDLE) gapHandles = gapHandles.filter((h) => h.handle.toLowerCase() === ONLY_HANDLE);

  const totalMissing = gapHandles.reduce((n, h) => n + h.missing.length, 0);
  console.log(`gap accounts: ${gapHandles.length}  uncaptioned submitted keys: ${totalMissing}`);
  console.log(
    `top accounts: ${gapHandles.slice(0, 8).map((h) => `${h.handle}(${h.missing.length})`).join(", ")}`,
  );

  if (gapHandles.length === 0) {
    console.log("nothing to do.");
    await prisma.$disconnect();
    return;
  }

  if (!APPLY) {
    console.log("\nDRY-RUN — no rows written. Re-run with --apply to fetch + upsert.");
    await prisma.$disconnect();
    return;
  }

  // 3. Page each gap account's business_discovery.media; upsert matched captions.
  //    stopBefore = corpus start minus a small margin (no link predates ~Apr 7).
  const stopBefore = new Date("2026-03-25T00:00:00.000Z");
  let captured = 0;
  let skippedNoCaption = 0;
  let unmatched = 0;

  for (const acct of gapHandles) {
    const want = new Set(acct.missing); // only these keys are worth storing
    const result = await fetchPublicInstagramCaptions([acct.handle], {
      maxPages: MAX_PAGES,
      stopBefore,
      onAccount: (h, posts, pages) => console.log(`  [${h}] paged ${pages}, ${posts} posts returned`),
    });
    const posts = result.get(acct.handle.toLowerCase()) ?? [];

    for (const p of posts) {
      const key = `ig:${p.shortcode}`;
      if (!want.has(key)) {
        unmatched++; // a post on this account that nobody submitted (or already ok) — ignore
        continue;
      }
      if (p.caption == null || p.caption.trim() === "") {
        skippedNoCaption++;
        continue;
      }
      try {
        await upsertLinkContent({ canonicalKey: key, title: null, caption: p.caption, status: "ok" });
        captured++;
        want.delete(key); // don't double-write within this run
      } catch (err) {
        console.error(`  [${acct.handle}] upsert failed for ${key}:`, err);
      }
    }
    console.log(`  [${acct.handle}] captured ${acct.missing.length - want.size}/${acct.missing.length} missing`);
  }

  console.log(
    `\n=== summary === captured=${captured}  skippedNoCaption=${skippedNoCaption}  unmatched(ignored)=${unmatched}`,
  );
  console.log("Newly-captured captions still need entity-extraction before they're searchable BY NAME.");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("backfill-ig-captions failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
