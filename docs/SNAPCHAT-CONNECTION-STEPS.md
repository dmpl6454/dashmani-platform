# Connecting Snapchat (feasibility + steps)

**Status: NOT feasible to auto-connect like YouTube / Instagram / Facebook. Manual entry only.**
Written 2026-06-25. The YouTube + Meta Graph **insights** work is merged (PRs #34–#37). Two further PRs are open at time of writing: **PR #38** (display-contradiction fixes — unifies the `InsightBadge`, shows FB views) and **PR #39** (`feat/follower-growth-graph-api` — the `meta-followers.ts` Graph follower fetchers, the `getGrowthOverview` admin API, and the `/accounts/growth` UI). **File/symbol references below that belong to PR #38/#39 only exist once those PRs merge** — they're called out inline. This documents *why* Snapchat can't be wired the same way, *what is possible today*, and a drop-in *playbook* to follow IF Snap ever ships a usable read API — mirroring the exact YouTube/Meta provider pattern this codebase already uses.

---

## TL;DR

| Capability | YouTube | Instagram / Facebook | **Snapchat** |
|---|---|---|---|
| Per-post engagement (views/likes/comments) via official API | ✅ YouTube Data API | ✅ Meta Graph API (System User token) | ❌ **No public read API for organic content** |
| Follower / subscriber count via official API | ✅ Data API | ✅ Graph `followers_count` | ❌ **No public follower-count API** |
| Caption/title read (for Link Search) | ✅ | ✅ | ❌ **No caption read path** |
| What we can do today | full auto | full auto (forward) | **manual entry only** |

**Recommendation:** allow Snapchat accounts/links to be logged with *manually-entered* metrics and follower counts — identical to the existing TikTok / LinkedIn / Twitter fallback. Do **not** build a scraper (same reasons we rejected one for IG/FB — see the crawler-rejection rule in CLAUDE.md). Revisit only if Snap publishes an organic-content read API.

---

## Why Snapchat can't be auto-connected (the real constraints)

1. **No follower/subscriber count is publicly exposed.** Unlike a YouTube channel (subscriber count) or a Meta Page/IG business account (`followers_count`), a Snapchat profile/Public Profile does not expose a stable, machine-readable follower number through any official API.

2. **No official read API for organic Story / Spotlight engagement.** Snap's developer surface is **ads-only**:
   - **Snap Marketing API** — manage ad campaigns/creatives, read *ad* performance. Not organic posts.
   - **Snap Conversions API (CAPI)** — send *your* conversion events to Snap for ad attribution. Write-only, not a content read API.
   - **Login Kit / Creative Kit / Bitmoji Kit** — auth + share-*into*-Snapchat, not read-*from*.
   There is **no** equivalent of the YouTube `videos?part=statistics` call or the Meta `/{post-id}/insights` call for a public Snap.

3. **Scraping is a dead end here** (same analysis as IG/FB, see CLAUDE.md "Why a free crawler is NOT used"): Snapchat is a client-rendered app gating content behind auth; a logged-out fetch hits a wall, a logged-in scrape is a ToS violation + ban risk, and the render needed would OOM the 2GB Linode. Snapchat is explicitly in the same "manual entry only" bucket as TikTok/LinkedIn/Twitter in [follower-sync.service.ts](../apps/api/src/services/follower-sync.service.ts) — see the comment block naming "snapchat / pinterest / telegram / tiktok / linkedin / twitter" as platforms that render client-side / gate behind auth / lack reliable proxies, and the `else` branch's `// tiktok, linkedin, twitter, snapchat, pinterest, telegram — manual entry only`.

4. **No fetch-by-id and no caption read** ⇒ **Link Search** (search posts by who/what they're about) also can't work for Snapchat: there is no caption to enrich, so the `link_content` → entity-extraction → search pipeline has nothing to ingest.

---

## What IS possible today: manual entry

This is the same path already used for TikTok / LinkedIn / Twitter. To enable Snapchat this way:

1. **Add a `snapchat` Platform row** (if not present). Platforms are seeded/managed as `Platform { name, slug }`. Add `{ name: "Snapchat", slug: "snapchat" }` via the seed or the Accounts admin UI. (The follower-sync `else` branch already treats any non-YT/IG/FB slug as manual — no code change needed for it to be skipped by the auto-sync.)
2. **Create Snapchat `SocialAccount`s** normally (handle + profileUrl). The hourly follower-sync will **skip** them automatically (the `else` branch increments `skipped` and moves on — see `syncAllFollowerCounts`), so they never error.
3. **Manual follower entry:** use the existing per-row pencil/refresh affordance on the Accounts page that already supports manual follower counts for the other unscrapable platforms. The number is stored on `SocialAccount.followerCount`. The **follower-growth charting UI (`/accounts/growth`, PR #39 — pending merge) will display it** — but only if daily `AccountGrowthSnapshot` rows exist. Today, a snapshot is written by the follower-sync only on a successful *auto*-fetch; a manual `followerCount` edit updates the account but does **not** by itself write a daily snapshot. So a manually-tracked Snapchat account would show a current count but a flat/empty growth line. If manual-Snapchat growth charting is wanted, a small additive follow-up would call `recordGrowthSnapshot()` on manual follower edits too (the `AccountGrowthSnapshot` table + `recordGrowthSnapshot()` in `account-growth.service.ts` already exist — no schema change).
4. **Manual link metrics (optional):** the HR Link Report form already lets employees type `views/likes/comments` per link. A Snapchat link logged there carries whatever the employee enters. The 6h insights cron will **not** touch it (Snapchat isn't in `SUPPORTED_INSIGHT_PLATFORMS`), so the manual numbers are preserved.

No Link Search coverage for Snapchat (no caption source) — the coverage banner simply won't list it, which is honest.

---

## Playbook: IF Snap ever ships an organic read API

If Snapchat releases a public read API for follower counts and/or organic Story/Spotlight engagement, the codebase is structured so Snapchat drops in alongside YouTube/IG/FB with **near-zero new wiring**. Follow the established provider pattern (this is exactly how IG and FB were added):

### Insights (views/likes/comments per link)
1. **Flip the single switch:** add `"snapchat"` to `SUPPORTED_INSIGHT_PLATFORMS` in [packages/shared/src/utils/social-insights.ts](../packages/shared/src/utils/social-insights.ts). Everything downstream (`isPlatformInsightSupported`, the cron's `getSupportedSlugs()`, the InsightBadge, the generalized `useTopLinks("snapchat", …)` Top-Links panel) keys off this one constant.
2. **Add a `snap:` branch to `canonicalKey()`** in [packages/shared/src/utils/canonical-url.ts](../packages/shared/src/utils/canonical-url.ts): extract the stable Story/Spotlight id and return `snap:{id}`. **Keep the opaque-fallthrough discipline** — if a Snapchat URL has no resolvable stable id (e.g. an ephemeral share link), fall through to the raw-lowercase default exactly like opaque `facebook.com/share/` links do; never guess (collapsing two unrelated opaque links would delete data). Add a corresponding `extractSnapchatPostId()` to the shared extractors.
3. **Create `apps/api/src/services/social-insights/snapchat.provider.ts`** implementing the same interface as the other providers (`slug`, `isSupported()`, `fetchBatch(targets)`, and optionally `harvestContent()`). Gate it on a `SNAPCHAT_TOKEN` env var with a `snapConfigured()` dark-switch — mirror `metaConfigured()` in [meta-graph.ts](../apps/api/src/services/social-insights/meta-graph.ts) so the provider is dark until the token is set (no rebuild, runtime-only). Make the fetch helper **injectable** for tests: the injectable fetch helper itself lives in `meta-graph.ts` (`graphFetch`), while each provider exposes its own `__setGraphFetchForTesting` setter (see `instagram.provider.ts` / `facebook.provider.ts`) so unit tests can swap in a mock and never touch the network.
4. **Register it** in [registry.ts](../apps/api/src/services/social-insights/registry.ts). The existing 6h [social-insights.cron.ts](../apps/api/src/cron/social-insights.cron.ts) will then poll Snapchat links automatically, write `link_metrics` rows, and (if `harvestContent` is implemented) enrich `link_content` captions — feeding Link Search with **zero search-side changes**.
5. **UI is already generalized:** the internal `/reports` Top-Links panels iterate a platform list and call `useTopLinks(platform, …)` ([use-reports.ts](../apps/internal/src/lib/hooks/use-reports.ts)); add a `snapchat` entry to that list (icon + label + a `showViews` flag). The unified `InsightBadge` (internal + HR, after PR #38) renders **views only when non-null, plus likes and comments** — so a Snapchat provider that returns, say, only likes+comments shows exactly those, no fake "—". (Before PR #38 the internal badge rendered views+likes only and dropped comments — don't model new work on that older behavior.)

### Follower growth
6. **Followers:** add a `fetchSnapchatFollowerMap()` to [meta-followers.ts](../apps/api/src/services/social-insights/meta-followers.ts) (the Graph follower-fetcher module **added in PR #39 — pending merge**; the IG/FB fetchers live there) or a sibling module, and a `slug === "snapchat"` branch in [follower-sync.service.ts](../apps/api/src/services/follower-sync.service.ts) that's **Graph-first / scrape-or-manual-fallback** just like IG/FB. The `AccountGrowthSnapshot` table + `recordGrowthSnapshot()`/`getAccountGrowth()` (already on `main`) and the `getGrowthOverview` admin aggregation + `/accounts/growth` UI (**PR #39 — pending merge**) all key on `accountId` and accept any platform — no growth-side change needed.

### Hard-won lessons to carry over (from the YouTube/Meta work)
- **Verify field names against the LIVE API, not just mocks.** The IG follower fetch shipped with a nested-field expansion that unit tests passed but the real API silently ignored (returned only `{id}`) — caught only by a live probe, then rewritten to a two-step. Do a one-off read against the real Snapchat token before trusting any provider.
- **Dual-id gotchas are real** (FB reels have a permalink id ≠ the `{pageId}_{postId}` insights id). Expect Snapchat may have a share-id ≠ content-id distinction; design `canonicalKey` for the *map key* and the insights call for whatever id the metrics endpoint actually accepts.
- **Forward coverage > historical.** IG/FB only resolve ~1% of historical posts (feed-firehose truncation) but capture ~all forward posts via the cron's `harvestContent`. Expect the same shape for Snapchat; set expectations in the coverage banner honestly per-platform.

---

## Decision

Manual entry now (no engineering work scheduled). The auto-connect playbook above is drop-in *if and when* Snap publishes an organic read API. Until then, Snapchat lives in the same manual bucket as TikTok/LinkedIn/Twitter — documented, honest, and not faked.
