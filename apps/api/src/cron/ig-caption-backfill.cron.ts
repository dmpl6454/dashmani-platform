import { prisma } from "@dashmani/db";
import { canonicalKey } from "@dashmani/shared";
import { fetchPublicInstagramCaptions } from "../services/social-insights/meta-followers";
import { upsertLinkContent } from "../services/link-content.service";

// ── IG caption backfill — spaced waves ───────────────────────────────────────
//
// WHY: ~30k submitted Instagram links point at ~63 EXTERNAL accounts we don't
// administer, so the owned-account harvest (instagram.provider) can't read their
// captions and those links aren't name-searchable. business_discovery.media CAN
// read any public account's captions, BUT Meta's app-level rate limit (#4) caps a
// single run to roughly ONE large account before it 403s (one big account's deep
// paging exhausts the budget). So a one-shot backfill is impossible.
//
// This cron closes the gap in SPACED WAVES: each hourly run backfills a SMALL,
// rotating slice of gap accounts (ACCOUNTS_PER_RUN), self-throttling under the
// limit. A rotating cursor (system_settings) advances through the 63 accounts so
// the whole set is covered over ~1-2 days, then it idles (no gap left). Forward
// coverage of these accounts still flows through the normal harvest for the ones
// we administer; this only fills the historical EXTERNAL tail.
//
// SAFETY: fail-open (fetchPublicInstagramCaptions never throws; rate-limit →
// partial). Shares the ~200-call/hr Meta budget politely. Idempotent: only
// captures keys still missing an 'ok' caption. DARK unless META_SYSTEM_USER_TOKEN
// is set. ADDITIVE — never deletes or demotes anything.

const CURSOR_KEY = "ig-caption-backfill:cursor"; // index into the sorted gap-account list
// How many accounts to attempt per hourly run. Kept small because one big account
// can alone hit the (#4) limit; a handful per hour stays polite and still covers
// the ~63 accounts in ~1-2 days. Tunable via env for a faster/slower drain.
const ACCOUNTS_PER_RUN = Number(process.env.IG_BACKFILL_ACCOUNTS_PER_RUN) || 4;
// Page depth per account. The corpus is ~11 weeks old, so a few dozen pages covers
// an account's in-corpus history; capped to bound per-account call volume.
const MAX_PAGES = Number(process.env.IG_BACKFILL_CRON_MAX_PAGES) || 30;
// No submitted link predates ~Apr 7; stop paging an account past this.
const CORPUS_START = new Date("2026-03-25T00:00:00.000Z");
const KEY_CHUNK = 20_000; // Postgres bind-variable cap guard

export async function runIgCaptionBackfill(): Promise<void> {
  const startedAt = Date.now();
  if (!process.env.META_SYSTEM_USER_TOKEN) {
    console.log("[ig-caption-backfill] META_SYSTEM_USER_TOKEN not set — skipping (dark)");
    return;
  }

  // 1. Build the gap: distinct IG accounts (by handle) owning >=1 submitted link
  //    whose ig:<shortcode> key has no 'ok' caption yet. Host-matched, not the
  //    dirty platform column.
  const igLinks = await prisma.reportLink.findMany({
    where: { isScheduled: false, url: { contains: "instagram.com", mode: "insensitive" } },
    select: { url: true, account: { select: { handle: true } } },
  });

  const submittedKeys = new Set<string>();
  const byHandle = new Map<string, { handle: string; keys: Set<string> }>();
  for (const l of igLinks) {
    if (!l.url) continue;
    const key = canonicalKey(l.url);
    if (!key || !key.startsWith("ig:")) continue;
    submittedKeys.add(key);
    const handle = (l.account?.handle || "").replace(/^@/, "").trim();
    if (!handle) continue;
    const hk = handle.toLowerCase();
    if (!byHandle.has(hk)) byHandle.set(hk, { handle, keys: new Set() });
    byHandle.get(hk)!.keys.add(key);
  }

  // Which submitted keys are already ok? (chunked — bind-var cap)
  const allKeys = [...submittedKeys];
  const okSet = new Set<string>();
  for (let i = 0; i < allKeys.length; i += KEY_CHUNK) {
    const rows = await prisma.linkContent.findMany({
      where: { canonicalKey: { in: allKeys.slice(i, i + KEY_CHUNK) }, status: "ok" },
      select: { canonicalKey: true },
    });
    for (const r of rows) okSet.add(r.canonicalKey);
  }

  // Gap accounts with >=1 missing key, sorted by handle for a STABLE rotation order.
  const gap = [...byHandle.values()]
    .map((h) => ({ handle: h.handle, missing: [...h.keys].filter((k) => !okSet.has(k)) }))
    .filter((h) => h.missing.length > 0)
    .sort((a, b) => a.handle.toLowerCase().localeCompare(b.handle.toLowerCase()));

  if (gap.length === 0) {
    console.log("[ig-caption-backfill] no IG caption gap remaining — idle");
    return;
  }

  // 2. Rotating cursor: pick ACCOUNTS_PER_RUN starting at the stored index, wrapping.
  const cursorRow = await prisma.systemSetting.findUnique({ where: { key: CURSOR_KEY } });
  let cursor = Number(cursorRow?.value);
  if (!Number.isFinite(cursor) || cursor < 0 || cursor >= gap.length) cursor = 0;

  const slice: typeof gap = [];
  for (let i = 0; i < Math.min(ACCOUNTS_PER_RUN, gap.length); i++) {
    slice.push(gap[(cursor + i) % gap.length]);
  }
  const nextCursor = (cursor + slice.length) % gap.length;

  console.log(
    `[ig-caption-backfill] gap=${gap.length} accounts; this run cursor=${cursor} → ${slice.map((s) => `${s.handle}(${s.missing.length})`).join(", ")}`,
  );

  // 3. Backfill each account in the slice. Fail-open per account.
  let captured = 0;
  for (const acct of slice) {
    const want = new Set(acct.missing);
    let posts;
    try {
      const result = await fetchPublicInstagramCaptions([acct.handle], { maxPages: MAX_PAGES, stopBefore: CORPUS_START });
      posts = result.get(acct.handle.toLowerCase()) ?? [];
    } catch (err) {
      // fetchPublicInstagramCaptions is fail-open, but guard anyway — one account
      // must never abort the run.
      console.error(`[ig-caption-backfill] ${acct.handle} fetch error (skipping):`, err instanceof Error ? err.message : err);
      continue;
    }
    for (const p of posts) {
      const key = `ig:${p.shortcode}`;
      if (!want.has(key)) continue;
      if (p.caption == null || p.caption.trim() === "") continue;
      try {
        await upsertLinkContent({ canonicalKey: key, title: null, caption: p.caption, status: "ok" });
        captured++;
        want.delete(key);
      } catch {
        /* per-key upsert failure must not abort the run */
      }
    }
  }

  // 4. Advance the cursor for next run.
  try {
    await prisma.systemSetting.upsert({
      where: { key: CURSOR_KEY },
      create: { key: CURSOR_KEY, value: String(nextCursor) },
      update: { value: String(nextCursor) },
    });
  } catch {
    /* cursor persistence is best-effort; a miss just re-does this slice next run */
  }

  console.log(
    `[ig-caption-backfill] done in ${Date.now() - startedAt}ms — captured ${captured} captions across ${slice.length} accounts; cursor→${nextCursor}/${gap.length}`,
  );
}
