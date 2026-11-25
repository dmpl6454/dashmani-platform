# Link Analytics — social post metrics and reports (sales portal)

Status: built on `feat/link-analytics` (2026-11-25). ⚠️ Apply `scripts/link-analytics-ddl.sql` on prod
(`bash scripts/apply-link-analytics-ddl.sh`) BEFORE merging.

Staff paste (or upload) hundreds or thousands of Facebook / Instagram post, reel or video links into a
named **batch**. The API validates and de-duplicates them, fetches the latest metrics through Meta's
official Graph API only, stores every check as a snapshot, and builds six reports with Excel / CSV / PDF /
JSON exports. Sales portal: `/links` (batches) and `/links/view?id=` (one batch).

---

## 1. What already existed, and what this reuses

| Existing piece | Used for | Why not something else |
|---|---|---|
| `meta_connections` / `meta_assets` (Meta OAuth, "Post Automation 2" app) | Tokens: IG reads use the connection's user token; FB reads use the asset's Page token. Asset = who owns a post. | The only grant with `pages_read_engagement` at Advanced Access, `instagram_manage_insights`. |
| `oauthGraphFetch` + `CallBudget` (`services/meta-oauth/oauth-graph.ts`) | Every Graph call. Never throws, reports `rateLimited` / `authInvalid` / usage headers. Called with `recordUsage:false`; one aggregate `api_usage` row per worker tick (posting-watch pattern). | One fetcher per app secret; zero edits to it. |
| `meta_posts` (latest state per post of our own assets, ~3-hourly sync) | **Owner lookup** (IG `match_id` = shortcode, FB `match_id`/`meta_post_id`) and the **cached fallback** when a live fetch is throttled. | It never holds third-party posts. |
| `canonicalKey`, `extractFacebookPostId`, `resolveOpaqueFacebookUrl` | URL normalisation and post-id extraction, FB `/share/` redirect resolution (one `redirect:manual` GET, reads only the `Location` header, no login, no HTML). | Same keys the rest of the platform already dedupes on. |
| `link_metrics` / Link History | **Not used, not written.** | It is keyed on employee daily reports and is the table that filled the disk (11 GB, 2026-10-25). This feature has its own small tables with retention. |
| Campaign delivery (`campaign/delivery.service.ts`) | Pattern only: it reads views/likes for a post URL from `meta_posts` by `canonicalKey` id. We do the same lookup, then fetch live. | — |

---

## 2. Which metrics are reachable (code + Meta docs, 2026-11)

Sources: `.planning/META-POST-INSIGHTS-LIVE-PROBE-2026-08-19.md` (live-probed), the comments in
`meta-posts.service.ts` (live-probed 2026-08-20/24 and 2026-09-19), the "INSIGHTS permission ceiling"
entry in `CLAUDE.md` (live-probed 2026-08-18), and Meta's current reference pages for business discovery,
IG Media, IG Media insights, Page Post, Page Public Content Access and oEmbed.

| Metric | Our IG account (connected) | Our FB Page (connected) | Someone else's IG business/creator account | Someone else's FB Page / profile | Personal IG account |
|---|---|---|---|---|---|
| Views / plays | ✅ `insights views` | ✅ `post_media_view` | ✅ reels only (`view_count`, business discovery) | ❌ | ❌ |
| Reach | ✅ `insights reach` | ✅ `post_total_media_view_unique` | ❌ private | ❌ | ❌ |
| Likes | ✅ `like_count` | ✅ `likes.summary` | ✅ `like_count` (absent if the owner hides counts) | ❌ | ❌ |
| Comments | ✅ `comments_count` | ✅ `comments.summary` | ✅ `comments_count` | ❌ | ❌ |
| Shares | ✅ `insights shares` | ✅ `shares.count` (absent = none → null) | ❌ (`shares_count` not available to business discovery) | ❌ | ❌ |
| Saves | ✅ `insights saved` | ❌ FB has no saves metric | ❌ (`saved_count` not available) | ❌ | ❌ |
| Account name / username | ✅ | ✅ | ✅ | ❌ | ❌ |
| Followers | ✅ (asset sync, cached) | ✅ (asset sync, cached) | ✅ `followers_count` | ❌ | ❌ |
| Caption / published time | ✅ | ✅ | ✅ | ❌ | ❌ |
| Thumbnail | ✅ signed, expires ~4.4 days | ✅ `full_picture`, same expiry | ✅ VIDEO only (`thumbnail_url`) | ❌ | ❌ |

Why the ❌ cells are ❌ — do not re-litigate without a new live probe:
- **Private insights (reach, saves, shares, impressions) need admin rights on the asset.** No permission at
  any access tier unlocks them for an asset nobody at Dashmani administers; App Review only lets *other*
  businesses grant us access through login. Probed live: business discovery `media{insights}` → `(#10)`.
- **Business discovery** looks up an account **by username only**, then pages its media (cursor paging,
  newest first). There is no lookup by shortcode. So a third-party IG link needs the username: the
  `instagram.com/<user>/reel/<code>` form carries it; for a bare `/p/<code>` link staff can type it in
  ("@handle" column on the batch). We page at most `LINK_ANALYTICS_BD_MAX_PAGES` (default 4 × 50 = the
  newest 200 posts) per account per run; an older post is Restricted with that reason.
- **Facebook posts on Pages we don't administer** need *Page Public Content Access*, a separate feature
  that requires App Review; neither of our apps has it, so `?fields=…` on a non-owned post returns `(#10)`.
  Personal-profile posts are never readable. These are Restricted, never zero.
- **oEmbed** is not used: since 2025-11-03 it returns no author or thumbnail, never any counts, and Meta's
  terms forbid using its metadata for analytics.
- **No scraping.** No logged-in session, no HTML parsing, no third-party scrapers. The only non-Graph
  request is the FB `/share/` redirect resolution described above.

## 3. Statuses (what the Status column shows)

| Status | Meaning | Data access |
|---|---|---|
| **Verified** | Post on one of our connected assets; metrics read live from the Graph API. | `full` |
| **Restricted** | Not ours. Either *public metrics* (IG business discovery: likes, comments, reel views, followers) or *none*. Always shows its reason. | `public` or `none` |
| **Failed** | We should be able to read it and could not (token dead, deleted post, throttled after 4 tries, network). Shows the error; retried on the next refresh. | — |
| **Pending** | Queued, not checked yet. | — |

Restricted reasons: `ig_no_username`, `ig_account_not_public` (personal, private or unknown username),
`ig_post_not_in_recent_media`, `fb_not_our_page`, `fb_unresolvable_link`, `no_meta_connection`.

A metric Meta does not publish for that post is `NULL` → shown as "—" ("unavailable"). Never 0.

**Live vs cached.** Every value carries `data_source` and `metrics_at`:
- `meta_graph` — live read from Graph for our own asset, at `metrics_at`.
- `meta_business_discovery` — live public read for a third-party IG account.
- `platform_sync` — the live read was throttled or out of budget, so the values come from the platform's
  background Meta sync (`meta_posts`), measured at its own `metrics_fetched_at`. Shown as **Cached**.
Followers for our own assets come from the asset sync (`meta_assets.follower_count`) and are labelled cached.

## 4. Data model (additive DDL, `scripts/link-analytics-ddl.sql`)

- `link_batches` — name, notes, keep_duplicates, `state` (idle | running | paused), run_started_at,
  refresh_every_hours (null | 6 | 12 | 24), schedule_ends_at (≤ 60 days out), next_refresh_at, created_by,
  archived_at.
- `link_batch_items` — one row per pasted line (valid, invalid and duplicate lines are all kept so the counts
  are honest): position, raw_url, normalized_url, platform, post_type, post_key, `validity`
  (valid | invalid | duplicate), invalid_reason, duplicate_of_id, username_hint, post_id.
- `link_posts` — ONE row per post across all batches (unique `post_key`): latest values, status, access,
  reason, source, metrics_at, owner (meta_asset_id), account fields, caption, thumbnail, plus queue fields
  (`fetch_state` queued | idle, next_attempt_at, attempts, lease_until). Two batches with the same post share
  one fetch.
- `link_post_snapshots` — one row per completed check of a post (values + source + status). First and
  latest give growth.

## 5. Processing

- In-process worker in the API (`services/link-analytics/worker.ts`), tick every 10 s while work exists,
  60 s idle. **All state is in Postgres**, so a restart loses nothing: a post is claimed with
  `FOR UPDATE SKIP LOCKED` and a 3-minute lease; an expired lease is simply claimed again.
- Only posts with at least one item in a **running** batch are claimed, so **pause** stops new fetches for
  that batch at once (an in-flight call finishes) and **resume** continues from where it stopped.
- **No double fetching:** queueing a post that was checked within `LINK_ANALYTICS_FRESH_MINUTES` (10) is a
  no-op unless the per-post refresh forces it; a post in several batches is one row and one fetch; IG
  business discovery pages each username once per tick for all its posts.
- **Budget:** ≤ `LINK_ANALYTICS_MAX_CALLS_PER_HOUR` (900) Graph calls per rolling hour, ≤ 30 posts per
  tick, concurrency 3. A usage header ≥ 75 % (or a rate-limit error) pauses the worker for
  max(10 min, Meta's regain estimate). The posts sync (~1,500/h) and posting watch keep running beside it.
  At 900/h a 1,000-link batch of our own posts takes about 70 minutes.
- **Retry:** transient failures (throttle, network, 5xx) back off 1 → 4 → 16 min; after 4 tries the post is
  Failed (with the cached `meta_posts` values attached if we have them, marked Cached).
- **Scheduled refresh:** every 6, 12 or 24 h for at most 60 days (re-enable to extend).

## 6. Reports and exports

Computed on demand from the batch's posts (nothing stored): executive summary, post-by-post table,
per-platform summary (totals, averages, top post), per-page summary, top content (top 10 by views, likes,
comments, shares + top 5 per platform), engagement analysis.

Formulas (also printed in every export):
- Engagement actions = likes + comments + shares, counting only the parts Meta published; a post missing
  any part is flagged "partial".
- Engagement rate (followers) = engagement actions ÷ account followers × 100, per post with both known.
- Engagement rate (reach) = engagement actions ÷ reach × 100, only where reach is known.
- Batch rates are weighted: Σ engagement ÷ Σ followers (or reach) over the posts that have both.
- Followers KPI = sum over **unique accounts** (each account counted once), with the account count.
- Sums count only posts that report the metric, and say "N of M posts".

Exports: Excel (Executive Summary, All Posts, Facebook, Instagram, Page-Wise, Top Posts, Failed Links,
Extraction History), CSV (all posts), branded PDF (cover, KPIs, sections, data limitations, generated-at),
JSON (the full report object).

## 7. Storage and retention (the disk filled on 2026-10-25)

- Snapshots: rows older than 30 days are thinned to the last check per post per IST day; the first ever
  snapshot of a post is always kept. Rough size: ~120 bytes/row; 1,000 posts refreshed every 6 h for 60 days
  ≈ 240k rows ≈ 30 MB before thinning.
- An archived batch is deleted (with its items) 30 days after archiving; posts no longer in any batch are
  deleted with their snapshots in the same nightly job (`link-analytics-retention`, 04:40 IST).
- Max 5,000 lines per paste/upload, 20,000 items per batch. Uploads are read in the browser and sent as
  text; no file is ever written to disk.

## 8. Not done / follow-ups

- FB video-only nodes (a `/videos/<id>` that is not in `meta_posts`) use the video node's own fields; its
  views metric needs a live probe on prod before it can be trusted (until then views stay "—").
- No webhooks; refresh is pull-only.
- Other platforms (YouTube via the existing API key path) plug in as another adapter in
  `services/link-analytics/adapters/`.
