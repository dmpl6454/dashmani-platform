// ── Snapchat Spotlight insight provider ──────────────────────────────────────
//
// Snapchat Spotlight videos (snapchat.com/spotlight/<id>) are public pages
// that expose view/like/comment counts and captions. This provider scrapes
// them using a Googlebot UA — the same technique as the Facebook reel scraper.
//
// ⚠️ MUST be live-verified from Linode datacenter IP before trusting results.
//   Residential success ≠ datacenter success (Snap's bot-detection may differ).
//   Kill switch: SC_PROVIDER_ENABLED=0
//
// Captions are returned in the InsightFetchResult (title/caption fields) and
// are automatically stored in link_content by the cron — no harvestContent()
// needed (same pattern as YouTube).
//
// Only Spotlight links (sc:spotlight:<id>) yield a targetId. Story links
// (sc:story:<id>) and profile links fall through to extractTargetId → null
// and are skipped by the cron — they have no stable engagement endpoint.

import type { InsightProvider, InsightTarget, InsightFetchResult } from "./types";

const SC_PROVIDER_ENABLED = process.env.SC_PROVIDER_ENABLED !== "0";
const DELAY_MS = parseInt(process.env.SC_PROVIDER_DELAY_MS ?? "400", 10);
const TIMEOUT_MS = 12_000;
const MIN_PAGE_LEN = 5_000;

const SCRAPER_UA =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

// Per-run block flag — trips after a non-404 HTTP error or login wall
let scProviderBlocked = false;

export function __resetSnapchatProviderForTesting(): void {
  scProviderBlocked = false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── HTML parser (exported for unit tests) ────────────────────────────────────

export interface ParsedSpotlight {
  views: number | null;
  likes: number | null;
  comments: number | null;
  caption: string | null;
}

function parseNumber(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.round(raw) : null;
  const s = String(raw).replace(/,/g, "").trim();
  const m = s.match(/^([\d.]+)\s*([KkMmBb])?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  const u = (m[2] ?? "").toLowerCase();
  if (u === "k") n *= 1_000;
  else if (u === "m") n *= 1_000_000;
  else if (u === "b") n *= 1_000_000_000;
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function parseSpotlightHtml(html: string): ParsedSpotlight {
  const empty: ParsedSpotlight = { views: null, likes: null, comments: null, caption: null };
  if (!html || html.length < MIN_PAGE_LEN) return empty;

  let views: number | null = null;
  let likes: number | null = null;
  let comments: number | null = null;
  let caption: string | null = null;

  // ── Strategy 1: __NEXT_DATA__ ─────────────────────────────────────────────
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>({[\s\S]*?})<\/script>/);
  if (nextDataMatch) {
    try {
      const nd = JSON.parse(nextDataMatch[1]);
      // Common shapes: pageProps.snap / pageProps.spotlight / pageProps.content
      const pp = nd?.props?.pageProps ?? {};
      const snap = pp.snap ?? pp.spotlight ?? pp.content ?? pp.snapData ?? {};
      views    = parseNumber(snap.viewCount   ?? snap.views      ?? snap.watchCount   ?? snap.playCount);
      likes    = parseNumber(snap.likeCount   ?? snap.likes      ?? snap.favoriteCount);
      comments = parseNumber(snap.commentCount ?? snap.comments);
      caption  = snap.caption ?? snap.title ?? snap.description ?? snap.overlayText ?? null;
    } catch { /* JSON parse fail — try next strategy */ }
  }

  // ── Strategy 2: JSON-LD ───────────────────────────────────────────────────
  if (views === null) {
    for (const block of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
      try {
        const ld = JSON.parse(block[1]);
        for (const stat of (ld?.interactionStatistic ?? [])) {
          const type = String(stat?.interactionType ?? "").toLowerCase();
          const count = parseNumber(stat?.userInteractionCount);
          if (count == null) continue;
          if (type.includes("watch") || type.includes("view")) views    ??= count;
          if (type.includes("like"))                           likes    ??= count;
          if (type.includes("comment"))                        comments ??= count;
        }
        if (!caption) caption = ld?.description ?? ld?.caption ?? null;
      } catch { /* ignore */ }
    }
  }

  // ── Strategy 3: inline JSON key patterns ─────────────────────────────────
  if (views === null) {
    const vm = html.match(/"viewCount"\s*:\s*(\d+)/) ?? html.match(/"watchCount"\s*:\s*(\d+)/);
    if (vm) views = Number(vm[1]);
  }
  if (likes === null) {
    const lm = html.match(/"likeCount"\s*:\s*(\d+)/) ?? html.match(/"favoriteCount"\s*:\s*(\d+)/);
    if (lm) likes = Number(lm[1]);
  }
  if (comments === null) {
    const cm = html.match(/"commentCount"\s*:\s*(\d+)/);
    if (cm) comments = Number(cm[1]);
  }

  // ── Strategy 4: og: meta tags ─────────────────────────────────────────────
  const ogDesc =
    (html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i) ?? [])[1] ??
    (html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:description"/i) ?? [])[1] ??
    "";
  if (views === null && ogDesc) {
    const vm = ogDesc.match(/([\d,.]+[KkMmBb]?)\s*views?/i);
    if (vm) views = parseNumber(vm[1]);
  }
  if (!caption && ogDesc.trim().length > 3 && !/^[\d,]+/.test(ogDesc.trim())) {
    caption = ogDesc.trim();
  }
  if (!caption) {
    const ogTitle =
      (html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) ?? [])[1] ?? "";
    if (ogTitle.trim().length > 3) caption = ogTitle.trim();
  }

  return { views, likes, comments, caption: caption ?? null };
}

// ── Provider ──────────────────────────────────────────────────────────────────

export const snapchatProvider: InsightProvider = {
  slug: "snapchat",

  isSupported(): boolean {
    return SC_PROVIDER_ENABLED;
  },

  extractTargetId(url: string): string | null {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, "");
      if (host !== "snapchat.com") return null;
      const m = u.pathname.match(/^\/spotlight\/([^/?#]+)/i);
      return m?.[1] ?? null;
    } catch {
      return null;
    }
  },

  async fetchBatch(targets: InsightTarget[]): Promise<Map<string, InsightFetchResult>> {
    const results = new Map<string, InsightFetchResult>();

    for (const target of targets) {
      if (scProviderBlocked) {
        results.set(target.linkId, {
          ok: false,
          status: "rate_limited",
          error: "Snapchat scraper blocked this run",
        });
        continue;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(
          `https://www.snapchat.com/spotlight/${encodeURIComponent(target.targetId)}`,
          {
            headers: {
              "User-Agent": SCRAPER_UA,
              "Accept-Language": "en-US,en;q=0.9",
              Accept: "text/html,application/xhtml+xml",
            },
            redirect: "follow",
            signal: controller.signal,
          }
        );
        clearTimeout(timer);

        if (!res.ok) {
          if (res.status === 404) {
            results.set(target.linkId, { ok: false, status: "not_found" });
          } else {
            // Non-404 HTTP error → treat as a block for this run
            scProviderBlocked = true;
            results.set(target.linkId, {
              ok: false,
              status: "rate_limited",
              error: `HTTP ${res.status}`,
            });
          }
          await sleep(DELAY_MS);
          continue;
        }
        if (/\/login|\/signup/i.test(res.url)) {
          scProviderBlocked = true;
          results.set(target.linkId, { ok: false, status: "rate_limited", error: "login wall" });
          continue;
        }

        const html = await res.text();
        const { views, likes, comments, caption } = parseSpotlightHtml(html);

        results.set(target.linkId, {
          ok: true,
          status: "ok",
          views,
          likes,
          comments,
          shares: null,
          title: null,
          caption,
        });
      } catch {
        clearTimeout(timer);
        results.set(target.linkId, { ok: false, status: "error", error: "timeout/network" });
      }

      await sleep(DELAY_MS);
    }

    return results;
  },
};
