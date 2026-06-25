# Public-engagement scraper — follow-up plan (IG + Snapchat)

Date: 2026-06-25. Shipped this pass: **Facebook** public-reel scraper fallback
(commit `fce7974`). This file plans the next two, which the user explicitly wants
("we have instagram as well… and any other platform as well") but agreed to land
*after* the FB win ships clean (so IG can be rate-tested at scale carefully).

## What was proven live (2026-06-25, against prod data + the Linode datacenter IP)

A logged-out GET with a **Googlebot User-Agent** (same trick the follower scraper
already uses — commit `b40b142`) returns public engagement, no login for FB:

| Platform | From Linode IP | Fields available (verified) | Notes |
|----------|----------------|------------------------------|-------|
| **Facebook** reel | **40/40 first-try, no block** | views=`video_view_count` (==Graph `post_video_views`, 5/5 EXACT), likes=`reaction_count.count`, comments=`total_comment_count` | SHIPPED. `play_count` is carousel noise — never use it. og:title unreliable. |
| **Instagram** post/reel | **soft login-wall ~70% on FIRST try; 8/8 WITH one retry** | likes + comments + caption + handle from `og:description` (`"1,089 likes, 8 comments - paphq…"`) | NO view count in og. Needs a retry loop. Higher ban risk at 40k scale. |
| **Snapchat** `/t/` | works (Googlebot AND chrome UA), no wall | likes + caption from `og:title` (`"16 likes | #VarunDhawan…"`) | NO views. Only 72 links exist. Overturns the doc's "Snapchat = manual only". |
| X / LinkedIn / TikTok | — | — | **ZERO links exist** in `report_links`. Not worth building. |

Link mix (prod, 2026-06-25): IG 40,835 · FB 19,324 · YT 1,947 · Snapchat 72 · unknown 3.

## Instagram scraper — the plan (HIGHER RISK than FB; do carefully)

The IG Graph provider already covers the ~38 IG accounts we administer (exact, free).
The scraper would backfill **likes + comments** (NOT views — IG og has none) for the
~external accounts the Graph can't reach. Build:

1. `instagram-scraper.ts` mirroring `facebook-scraper.ts`:
   - Googlebot UA, `redirect: follow`. Parse `og:description` → `N likes, M comments`.
   - Detect the login wall: final url contains `/accounts/login` OR body < ~50KB OR no
     `og:description` with "likes". On a wall, **RETRY once** (the soft wall yields on
     retry — 8/8 proven). Cap at 2 attempts total; treat a persistent wall as a miss.
   - Fail-open: any miss → all-null → caller keeps Graph's not_found.
2. Wire into `instagram.provider.ts` not_found branch, EXACTLY like FB:
   - Graph first (exact for administered); scraper fallback for the rest.
   - `IG_SCRAPER_ENABLED` kill switch (default ON, but...), call-time read.
3. **Rate / ban safety is the crux (why this is a follow-up, not bundled):**
   - 40,835 IG links × ~2 requests (retry) is a LOT from one datacenter IP. IG bans
     datacenter IPs faster than FB (proven: FB 40/40 first-try, IG ~30% first-try).
   - MUST: per-run cap (e.g. only scrape N not_found IG links per cron run, oldest-
     metric-first), generous inter-call delay (≥ 500ms, higher than FB's 250ms), and a
     **per-run block short-circuit** that trips after K consecutive walls-after-retry
     (stop hammering the moment IG starts walling — a rising wall rate = "back off").
   - Consider a separate, slower cadence than the 6h metric cron, or a dedicated cron.
   - Verify LIVE from the server at small scale FIRST (e.g. 200 links), watch the wall
     rate over a full run, before unleashing on 40k. Do NOT trust local/residential
     success — residential was 5/5, datacenter was ~30% first-try. The IP matters.
4. Tests mirror FB: parser unit (og:description → likes/comments; wall guard; partial),
   provider fallback (not_found→scraped ok; wall-after-retry stays not_found; disabled;
   administered still prefers Graph).

⚠️ The CLAUDE.md "no IG/FB caption scraper" rule was about (a) login-walled CAPTIONS
and (b) 27k requests → IP ban. The og:description path here is logged-OUT public data
(no ToS login bypass), but the **IP-ban concern is REAL for IG** — that's exactly why
this needs careful rate-limiting + live small-scale verification, not a blind 40k sweep.

## Snapchat scraper — the plan (LOW RISK, LOW VALUE — 72 links)

1. `snapchat-scraper.ts`: GET the `/t/<code>` (follows 302 → `/p/<uuid>`), parse
   `og:title` → `N likes` + caption. No view count. Fail-open.
2. Snapchat currently has NO provider (it's in the manual-entry bucket). Two options:
   - (a) Add a minimal `snapchat.provider.ts` whose fetchBatch is scrape-only (no Graph),
     add `snapchat` to `SUPPORTED_INSIGHT_PLATFORMS`, register it. OR
   - (b) Given only 72 links, defer — the ROI is marginal vs IG.
3. If built: same kill switch + delay + fail-open + tests pattern.
4. Update `docs/SNAPCHAT-CONNECTION-STEPS.md` — the "no caption read path / manual only"
   conclusion is **disproven for public `/t/` links** (likes + caption ARE in og:title).

## Cross-cutting (applies to all scrapers)

- Googlebot UA is the key (chrome UA gets the empty app-shell for IG/FB).
- Always verify a NEW scraper LIVE **from the Linode IP**, not locally — datacenter
  blocking is invisible from a residential IP (the whole reason the IG result differs).
- Fail-open is non-negotiable: a scrape miss must never null a Graph value or block the
  cron. The metric write only happens on a real number.
- Shares aren't in any public HTML — leave `shares: null` for scraped results.
- The FB administered overlap is ~5-15% (1,010/19,569 at shallow paging; deeper = more)
  — so the scraper is the PRIMARY coverage path, Graph the exact cross-check on the slice.
