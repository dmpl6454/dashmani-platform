import { extractSnapchatSpotlightId } from "@dashmani/shared";
import type { InsightProvider, InsightTarget, InsightFetchResult, HarvestedContent } from "./types";
import {
  scrapeSnapchatSpotlightEngagement,
  type FetchFn as ScraperFetchFn,
} from "./snapchat-scraper";

// ── Snapchat Spotlight insight provider (public-web scraper — no API/token) ─────
//
// Snapchat has NO usable public API for organic engagement (the Public Profile API
// is allowlist-gated + owned-content-only — see docs/SNAPCHAT-CONNECTION-STEPS.md).
// But a logged-out Googlebot-UA GET of a public /spotlight/<id> page returns real
// engagement in a __NEXT_DATA__ blob — verified live from the Linode IP 2026-07-14.
// This provider scrapes that (snapchat-scraper.ts) for every submitted link that
// resolves to a Spotlight. Links that are ephemeral Stories (or unresolved shares)
// have no scrapeable spotlight id → not_found (honest; surfaced in the coverage note).
//
// NO DARK SWITCH: the scraper needs no token, so isSupported() is always true. The
// only kill switch is SNAP_SCRAPER_ENABLED=0 (matches FB_SCRAPER_ENABLED).
//
// TARGET RESOLUTION: submitted links are `snapchat.com/t/<code>` shares. The cron's
// extractTargetId only succeeds on ALREADY-RESOLVED `/spotlight/<id>` urls. The
// submit path (daily-report.service.ts) resolves /t/ → clean /spotlight/ url via
// resolveSnapchatShareUrl (below) BEFORE storing, so forward links come in keyable;
// the 124-link historical tail is resolved once by scripts/resolve-snapchat-links.ts.

const snapScraperEnabled = () => process.env.SNAP_SCRAPER_ENABLED !== "0";
const snapScraperDelayMs = () => Number(process.env.SNAP_SCRAPER_DELAY_MS) || 300;
const snapScraperWallLimit = () => Number(process.env.SNAP_SCRAPER_WALL_LIMIT) || 5;

// Per-run block short-circuit (reset each fetchBatch), mirrors the FB scraper.
let snapScraperBlocked = false;
let snapScraperConsecutiveWalls = 0;

// Injectable scraper fetch (tests pass a stub; real path uses global fetch).
let scraperFetchImpl: ScraperFetchFn | null = null;
export function __setScraperFetchForTesting(fn: ScraperFetchFn | null): void {
  scraperFetchImpl = fn;
}
export function __resetSnapchatStateForTesting(): void {
  snapScraperBlocked = false;
  snapScraperConsecutiveWalls = 0;
  lastHarvest = [];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Captions harvested this run, keyed sc:<id>, for harvestContent(). Reset each run.
let lastHarvest: HarvestedContent[] = [];

export const snapchatProvider: InsightProvider = {
  slug: "snapchat",

  isSupported() {
    return snapScraperEnabled();
  },

  extractTargetId(url: string): string | null {
    // Only a RESOLVED /spotlight/<id> url yields an id. /t/ shares + /p/<uuid>/<story>
    // return null → the cron skips them (share resolution happens at submit time /
    // in the backfill, not here).
    return extractSnapchatSpotlightId(url);
  },

  async fetchBatch(targets: InsightTarget[]): Promise<Map<string, InsightFetchResult>> {
    const results = new Map<string, InsightFetchResult>();
    snapScraperBlocked = false;
    snapScraperConsecutiveWalls = 0;
    lastHarvest = [];

    if (!snapScraperEnabled()) {
      for (const t of targets) results.set(t.linkId, { ok: false, status: "error", error: "SNAP_SCRAPER_ENABLED=0" });
      return results;
    }

    for (const t of targets) {
      if (snapScraperBlocked) {
        results.set(t.linkId, { ok: false, status: "rate_limited", error: "Snapchat scraper blocked this run" });
        continue;
      }
      await sleep(snapScraperDelayMs()); // polite spacing

      const m = scraperFetchImpl
        ? await scrapeSnapchatSpotlightEngagement(t.targetId, scraperFetchImpl)
        : await scrapeSnapchatSpotlightEngagement(t.targetId);

      if (m.walled) {
        snapScraperConsecutiveWalls++;
        if (snapScraperConsecutiveWalls >= snapScraperWallLimit()) {
          snapScraperBlocked = true;
          console.warn(
            `[social-insights/snapchat] scraper hit ${snapScraperConsecutiveWalls} consecutive walls — short-circuiting for the rest of this run`
          );
        }
        results.set(t.linkId, { ok: false, status: "not_found" });
        continue;
      }
      snapScraperConsecutiveWalls = 0;

      // A hit = at least one real signal (metric OR caption). All-null non-walled =
      // a real page with nothing parseable (or a Story with -1 → null) → not_found.
      if (m.views == null && m.comments == null && m.shares == null && m.caption == null) {
        results.set(t.linkId, { ok: false, status: "not_found" });
        continue;
      }

      results.set(t.linkId, {
        ok: true,
        status: "ok",
        views: m.views,
        likes: null, // Snapchat has no public Spotlight like metric.
        comments: m.comments,
        shares: m.shares,
        title: null,
        caption: m.caption,
      });

      // Harvest the caption for Link Search (keyed sc:<spotlightId>).
      if (m.caption) {
        lastHarvest.push({ canonicalKey: `sc:${t.targetId}`, caption: m.caption, title: null });
      }
    }

    return results;
  },

  harvestContent(): HarvestedContent[] {
    return lastHarvest;
  },
};

// ── Submit-time share resolver (mirrors resolveFacebookShareUrl) ───────────────
//
// Does ONE redirect:follow fetch of a `snapchat.com/t/<code>` share link and reads
// the final resolved URL. If it lands on a /spotlight/<id> (a Spotlight), returns a
// CLEAN `https://www.snapchat.com/spotlight/<id>` URL. If it lands on a
// /p/<uuid>/<storyId> STORY (no spotlight id) → returns null (GIVE UP; a Story has
// no public stats). FAIL-OPEN: any throw/timeout → null, caller keeps the original.
const RESOLVE_UA =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const RESOLVE_TIMEOUT_MS = 10_000;

export async function resolveSnapchatShareUrl(
  url: string,
  fetchImpl: typeof fetch = fetch,
  externalSignal?: AbortSignal
): Promise<string | null> {
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": RESOLVE_UA },
      redirect: "follow",
      signal: controller.signal,
    });
    const finalUrl = res.url || "";
    const id = extractSnapchatSpotlightId(finalUrl);
    return id ? `https://www.snapchat.com/spotlight/${id}` : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
  }
}
