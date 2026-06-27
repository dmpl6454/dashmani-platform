# Facebook + Instagram Link Insights — Implementation Plan

**Status:** PLANNING ONLY — no code written yet.
**Date:** 2026-06-04
**Goal:** Get per-post likes / comments / views (and reach/shares where available) for Facebook & Instagram links, surfaced the same way YouTube insights already are (Internal `/reports` panel + HR `/report` panel).

---

## TL;DR — the one thing that makes this different from YouTube

YouTube works with a single **app-level API key** (`YOUTUBE_API_KEY`) that reads *public* stats for *any* video by ID, with no user login. **Meta has no equivalent.** Every read of FB/IG engagement requires an **OAuth access token belonging to the account that owns the post**, and the IG account must be **Business/Creator + linked to a Facebook Page**.

✅ **Confirmed by the user (2026-06-04): all tracked IG/FB accounts are Business/Creator + Page-linked.** This unblocks the feature — the data is accessible. The only question is *how we obtain and store the token(s)*.

The Meta Graph API itself is **free** ([Meta does not charge for the Instagram Graph API](https://developers.facebook.com/products/instagram/apis/)). There is **no separate "free shortcut" API** worth using — the so-called free options (Phyllo free tier, scrapers, etc.) are either rate-capped trials or unreliable/ToS-violating. **The genuinely free + reliable path is Meta's own Graph API; the two viable variants differ only in token acquisition.**

---

## Prod data reality (sampled read-only 2026-06-04)

Sampled `report_links` on prod (`dashmani_prod` via `ssh linode` + psql). This drives the recommendation:

| Platform | Total links | Notes |
|---|---|---|
| **instagram** | **19,526** | 45× YouTube's volume — this is a *primary* surface, not a side feature |
| **facebook** | **7,310** | |
| youtube | 431 | (the one we already ship) |
| snapchat | 56 | |

**Instagram URL shapes** — mostly clean, directly extractable:
- `/reel/<shortcode>` — **14,489** (e.g. `instagram.com/reel/DZAR7Ndk37t/?utm_source=…`)
- `/p/<shortcode>` — **3,713** (e.g. `instagram.com/p/DZAzhcZNTsT/?igsh=…`)
- **1,324 mislabeled** — rows where `platform='instagram'` but the URL is actually `facebook.com/share/...` (employees paste into the wrong field).

→ **18,202 IG links carry a clean shortcode** → `extractInstagramShortcode()` is real regex, NOT feed-matching. IG is the tractable, high-value win.

**Facebook URL shapes** — dominated by opaque links:
- `/share/r/<opaque>` — **6,121** (e.g. `facebook.com/share/r/181uwpf9M7/`) — resolves to a real post only by following a redirect, usually landing on a `pfbid…` permalink with no stable queryable ID.
- `/reel/<numeric-id>` — **1,188** (e.g. `facebook.com/reel/841188021963723/`) — these DO have a clean numeric ID.
- `pfbid` permalink — 1.

→ FB is genuinely hard via **any** method. ~84% of FB links are `/share/r/` opaque redirects. The `/reel/<id>` ones (1,188) are extractable; the rest need redirect-following + feed-matching.

**Two cross-cutting data facts that any implementation must handle:**
1. **Classify by URL, not the `platform` column** — the column is dirty (1,324 IG rows are really FB).
2. **Strip UTM/igsh tracking params** before ID extraction (every IG URL has `?utm_source=ig_web_copy_link&igsh=…`). The existing `sanitizeAccountHandle()` precedent (`.split("?")[0]`) applies.

---

## Why NOT a scraper/crawler (revisited with prod data)

The volume + clean IG shortcodes *feel* scraper-friendly, but the data argues the opposite:

- **~27k IG+FB page loads per 6h cron from one server IP** = textbook bot signature → IP ban in days. YouTube's 431 flew under the radar; 27k will not.
- **Login/consent wall** — logged-out scrapers get a "log in to see" interrupt; engagement counts are behind it.
- **Client-rendered SPAs** — counts aren't in initial HTML → need a **headless browser per link**. 27k headless renders/cycle is infeasible on the **2GB Linode** that already OOM-kills `turbo build` (CLAUDE.md).
- **FB `/share/r/` (6,121)** — a scraper still has to follow the redirect AND defeat the login wall AND parse a SPA. Worst case for scraping.
- **Precedent:** TikTok/LinkedIn/Twitter scrapers were **already removed as unscrapable** (`b40b142`); FB scraping only ever yielded *follower counts* via a brittle Googlebot-UA hack. Per-post engagement is strictly harder, at 60× the volume, on a RAM-starved box.

**Verdict:** scraping engagement = harder than the follower-scraping you already abandoned, at far higher volume, less reliable. Rejected as the foundation.

---

## Revised recommendation (data-informed)

Split the platforms by tractability instead of treating them as one feature:

1. **Instagram FIRST, via the free Meta Graph API + System User token (Path 1).** 18,202 clean shortcodes, 45× YouTube volume, highest value. This is the YouTube-grade win.
2. **Facebook SECOND, accept partial coverage.** Do the 1,188 clean `/reel/<id>` links via the same Graph API token; the 6,121 `/share/r/` opaque links require redirect-resolution + feed-matching (best-effort, may never be 100%). Don't block the IG win on solving FB completely.

---

## The two paths (both use the free Meta Graph API)

### ⭐ Path 1 — System User token (RECOMMENDED — this is the "quick + free + reliable" answer)

A **System User** is a non-human, server-side identity inside a Meta Business Manager. You generate a long-lived (or effectively non-expiring, if configured) token *once* in the Business Manager UI, assign it to the Pages/IG accounts in your business portfolio, and store it server-side. **No per-employee login flow, no OAuth UI to build.** This is the closest thing to the YouTube experience.

- **Why it fits us:** Dashmani manages the IG/FB accounts on behalf of clients. If those accounts (or the clients' Pages) live in — or can be shared into — **one Dashmani Business Manager**, a single System User token can read insights for *all of them*. That's the whole feature with almost no UI.
- **Token lifespan:** System User tokens can be generated as **60-day** or, for some configurations, **non-expiring** server tokens. Even the 60-day ones are [refreshable after 24h](https://developers.facebook.com/docs/instagram-platform/reference/refresh_access_token/) — we add one refresh cron (cheap).
- **Permissions needed:** `pages_read_engagement`, `instagram_basic`, `instagram_manage_insights`, `read_insights`. Requires **Meta App Review** to use these outside dev mode (one-time, ~days).
- **Build cost:** ~2–4 days (mostly the providers + a `meta_tokens` settings row + App Review paperwork). **No OAuth connect UI.**
- **Hard requirement:** every tracked Page/IG account must be added to (or shared into) the Dashmani Business Manager portfolio. This is an *ops* task, not a code task.

**Sources:** [Access Token reference](https://developers.facebook.com/docs/instagram-platform/reference/access_token/), [Instagram API pricing — free](https://www.getphyllo.com/post/instagram-api-pricing-explained-iv), [Overview](https://developers.facebook.com/docs/instagram-platform/overview/)

### Path 2 — Per-account OAuth connect flow (the "proper" multi-tenant way)

Each employee/client clicks "Connect Facebook," logs in, grants permissions; we store *their* long-lived token and refresh it. This is what the CLAUDE.md notes call the *"pending OAuth build."*

- **When you'd need this instead of Path 1:** if the accounts canNOT all be consolidated into one Business Manager (e.g. clients refuse to share their Pages into Dashmani's portfolio, or accounts are scattered across many unrelated owners).
- **Build cost:** ~1–2 weeks (OAuth redirect handling, token table per account, refresh cron, a "Connect" UI in the portal, error/disconnect states) + App Review.
- More moving parts, more user friction, more tokens to keep alive.

**Recommendation:** **Start with Path 1.** It's free, reliable, and dramatically less work. Fall back to Path 2 only if the Business-Manager consolidation turns out to be impossible. The provider code is *identical* either way — only the token *source* differs — so Path 1 → Path 2 is not a rewrite, just a token-lookup swap.

### Paths explicitly rejected
- **Scraping** — TikTok/LinkedIn/Twitter scrapers were already removed as unscrapable (CLAUDE.md `b40b142`), and FB only yields *follower counts* via a brittle Googlebot-UA hack. Per-post engagement scraping is more fragile and violates Meta ToS. Wrong foundation for a relied-upon feature.
- **Third-party aggregators (Phyllo/SociaVault/Data365)** — viable and give a YouTube-like single key, but they cost money monthly and still need Business accounts. Only revisit if Meta App Review is rejected. Not "free."

---

## Why our architecture is already 90% done

The YouTube implementation was deliberately built generic. **Nothing below needs to change** — it already works for any provider:

| Layer | File | Status |
|---|---|---|
| Provider interface | `apps/api/src/services/social-insights/types.ts` | ✅ Generic (`InsightProvider`) |
| Provider registry | `apps/api/src/services/social-insights/registry.ts` | ✅ Already lists `instagramProvider`, `facebookProvider` |
| Cron poller | `apps/api/src/cron/social-insights.cron.ts` | ✅ Loops `getSupportedSlugs()`, batches, writes `LinkMetric`, re-heals orphans |
| DB table | `LinkMetric` in `schema.prisma` | ✅ Platform-agnostic (`platform` string, nullable `videoId`) |
| Service/aggregation | `apps/api/src/services/social-insights.service.ts` | ✅ Generic; already marks `supported: isPlatformInsightSupported()` per platform |
| API routes | `admin-reports.routes.ts`, `hr.routes.ts` | ✅ Generic; ⚠️ keep insight routes *before* `/:reportId` |
| Internal UI | `apps/internal/src/app/reports/page.tsx` | ✅ Consumes `useInsightsSummary` / per-platform breakdown |
| HR UI | `apps/hr/.../report` insights panel | ✅ Consumes `useMyLinkInsights` |
| The on/off switch | `SUPPORTED_INSIGHT_PLATFORMS` in `packages/shared/src/utils/social-insights.ts` | 🔲 Flip when providers are live |

**The only NEW code is the two providers + their URL-ID extractors + a token store.**

---

## Implementation steps (Path 1 — System User token)

### Step 0 — Ops prerequisites (NOT code; do these first)
1. Create/confirm a **Meta Business Manager** for Dashmani.
2. Add every tracked **Facebook Page** + connected **Instagram Business account** into that Business Manager's portfolio (or have clients share them in).
3. Create a **Meta App** (type: Business) → note App ID + App Secret.
4. Create a **System User** in Business Settings → generate a token with `pages_read_engagement`, `instagram_basic`, `instagram_manage_insights`, `read_insights`.
5. Submit the app for **App Review** for those permissions (required to leave dev mode). Until approved, only accounts with a role on the app return data — fine for testing.

### Step 1 — Token storage (small, additive)
- Reuse the existing `system_settings` table (already added 2026-05-22 for SOP content) to store the System User token + its expiry, OR add a tiny `meta_credentials` row. **Additive only** — needs `db:push` on Linode.
- Add `META_APP_SECRET` to `apps/api/.env` (runtime-only, like `YOUTUBE_API_KEY` — no rebuild). The long-lived token itself lives in the DB so it can be refreshed without a redeploy.

### Step 2 — URL → ID extractors (in `packages/shared/src/utils/`)
Mirror `youtube.ts`. New files:
- `instagram.ts` → `extractInstagramShortcode(url)` — handles `/p/<code>/`, `/reel/<code>/`, `/tv/<code>/`. (Note: IG URLs give a *shortcode*, not the numeric media ID — the provider resolves shortcode→media-id via the Graph API, or we match on the owning IG account's media list.)
- `facebook.ts` → `extractFacebookPostId(url)` — handles `/{page}/posts/{id}`, `/photo.php?fbid=`, `/{page}/videos/{id}`, `story_fbid`, and `pfbid…` permalinks (these need resolving via the page's feed since `pfbid` is opaque).
- Export both from `packages/shared/src/index.ts`.

> ⚠️ **Reality check on URL→ID:** Meta post/media IDs are NOT cleanly embedded in modern URLs the way YouTube video IDs are. The robust approach is: for each owning account's token, page through that account's recent media (`/{ig-user-id}/media` or `/{page-id}/posts`) and **match the submitted URL's permalink to a media object**, then read `like_count` / `comments_count` / insights off the matched object. The cron already scopes to last 60 days, which keeps this feed-paging bounded. Document this clearly so we don't assume YouTube-style direct ID extraction.

### Step 3 — Fill in the providers
`apps/api/src/services/social-insights/instagram.provider.ts` and `facebook.provider.ts`:
- `slug`: `"instagram"` / `"facebook"`.
- `isSupported()`: return `true` only if a valid Meta token is present in the store (mirrors how `youtube.provider` checks `YOUTUBE_API_KEY`).
- `extractTargetId(url)`: use the new extractors.
- `fetchBatch(targets)`:
  - **Instagram:** for each target, `GET /{media-id}?fields=like_count,comments_count,media_type,permalink&access_token=…`; for views on Reels/video, `GET /{media-id}/insights?metric=plays,reach&access_token=…`. Map to `InsightFetchResult` (`views`, `likes`, `comments`, `shares` where available). Respect the **200 calls/user/hour** rate limit ([Phyllo](https://www.getphyllo.com/post/instagram-api-integration-101-for-developers-of-the-creator-economy)) — add the same quota-abort flag pattern `youtube.provider` uses for `quotaExceeded`.
  - **Facebook:** `GET /{post-id}?fields=likes.summary(true),comments.summary(true),shares&access_token=…`. Note: **share count via API is unreliable/being deprecated** — [several Page Insights metrics deprecate June 15, 2026](https://developers.facebook.com/docs/graph-api/reference/insights/), so treat `shares` as best-effort/nullable.
  - Status mapping identical to YouTube: `ok` / `not_found` (deleted/private) / `rate_limited` / `error`.
  - Use the same `AbortController` 10s timeout per request.

### Step 4 — Flip the switch
In `packages/shared/src/utils/social-insights.ts`:
```ts
export const SUPPORTED_INSIGHT_PLATFORMS = ["youtube", "instagram", "facebook"] as const;
```
That single line lights up the cron, the service `supported` flags, and the UI badges. **Do this LAST**, only after the providers return real data in testing — otherwise the UI will advertise support that doesn't work yet.

### Step 5 — Token refresh cron (Path 1)
Add a small daily cron (or extend `social-insights.cron.ts`) to refresh the long-lived token while it's 24h–60d old, writing the new token back to the DB. Mirrors the existing cron-bootstrap pattern in `src/index.ts`.

### Step 6 — Verify + deploy
- `npx tsc --noEmit` on api + shared; `npm run build` (all apps).
- `db:push` on Linode (token storage column is additive — confirm no DROP).
- Set `META_APP_SECRET` + seed the System User token on prod.
- Watch one cron cycle in logs; confirm `link_metrics` rows appear with `platform = 'instagram' | 'facebook'` and non-null likes/comments.
- Hard-refresh Internal `/reports` and HR `/report` — the existing panels should now show IG/FB rows.

---

## Honest risks / gotchas
- **App Review is a real gate.** Meta can reject; budget days-to-weeks. Until approved, only app-role accounts return data (good enough for dev/testing).
- **URL→ID is the hardest sub-problem** (see Step 2 reality check). Modern `pfbid…` FB permalinks and IG shortcodes need feed-matching, not regex extraction. This is where the build time actually goes.
- **Rate limits** (IG 200/user/hr). The 60-day poll window + batching + the quota-abort flag (copied from YouTube) keep us inside them, but verify under real volume.
- **`shares` is unreliable on FB** and Page Insights metrics deprecate **June 15, 2026** — design `shares`/`views` as nullable best-effort, never required.
- **Business-Manager consolidation** is the make-or-break ops dependency for Path 1. If clients won't share Pages in, fall back to Path 2 (per-account OAuth) — same providers, different token source.

---

## Effort summary

| Path | New code | UI work | Ops | App Review | Cost |
|---|---|---|---|---|---|
| **Path 1 — System User** ⭐ | 2 providers + 2 extractors + token store + refresh cron | None (panels exist) | Consolidate accounts into 1 Business Manager | Yes (1×) | **Free** |
| Path 2 — Per-account OAuth | Same providers + per-account token table + OAuth redirect | "Connect FB" flow + states | Per-account connect | Yes (1×) | Free |
| Aggregator (fallback) | Providers against vendor API | None | Vendor onboarding | No | **$/month** |

**Recommended:** Path 1. Free, reliable, ~2–4 days of code, no new UI, and a clean upgrade path to Path 2 if consolidation proves impossible.