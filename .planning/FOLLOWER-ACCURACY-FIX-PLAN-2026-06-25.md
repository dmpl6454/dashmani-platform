# Follower Accuracy & Coverage Fix — 2026-06-25

## The report
User noticed Account Growth showed Bollywood Society (IG) = **4.2m** but the live IG profile
shows **4.6m** (65,037 posts / 4.6m followers / 355 following). Asked: verify all channels,
find alternatives for unreachable accounts ("I'm confident we have access"), get accurate
metrics **at all times**, and label very-accurate vs off data in the UI.

## Root cause (verified live against prod Meta token + DB, 2026-06-25)

**The follower-sync ENGINE is accurate where the token reaches** — of 144 IG rows, 33 match a
live Graph account by handle and **0/33 are materially off (all within 2%)**. The problem is
**coverage**, not correctness:

| Platform | rows | live-synced (48h) | never-synced (stale/manual) |
|----------|------|-------------------|------------------------------|
| Facebook | 277  | 97                | **177** |
| Instagram| 144  | 35                | **109** |
| YouTube  | 22   | 19                | 3 |
| X        | 8    | 0                 | **8** |
| Snapchat | 7    | 0                 | **7** |

`bollywoodsocietyy` IG row: `follower_count=4,209,514`, **`last_synced_at=NULL`**, 0 snapshots.
It is NOT among the 38 IG accounts on the 87 Pages our System User administers — so it was never
fetched live; 4.2m is a frozen legacy/manual value. (We administer 87 Pages → 38 linked IG accounts.)

The growth headline `totalFollowers≈286.5M` sums ALL stored follower rows (fresh + stale + the
same brand's FB+IG+YT), so it reads as live-precise when much of it is stale/manual.

## The recoverable path — VERIFIED LIVE (the "alternative" the user was confident existed)

**Instagram `business_discovery`** — one of OUR connected IG nodes can look up ANY *public
business/creator* IG account by username; no admin access required, ToS-compliant.
Proven on 8 stale handles → **7 recovered with exact live counts**:
- bollywoodsocietyy: 4,209,514 → **4,621,284 live** (+411,770) ✓ matches screenshot's 4.6m
- filmeflicks 4,078,246→3,952,922 · movie_review_preview 1,833,259→2,125,845 ·
  bollywoodreporter.in→2,003,297 · totalfilmii→1,142,464 · movifiedbollywood→878,482 · crazy4bolly→480,184
- `indenews.in` → HTTP 400 "Invalid user id" = renamed/private/personal (NOT a public business acct).
  This is the clean, detectable failure mode → those rows stay manual + labelled.

Endpoint shape (verified):
`GET /v21.0/{ourIgId}?fields=business_discovery.username({handle}){followers_count,media_count}&access_token=…`
Mirror `meta-followers.ts` for the token + discovery of `{ourIgId}` (any one connected IG node works).

### Other platforms — verified, do NOT over-promise
- **YouTube**: `forHandle=@{storedHandle}` returned "no items" for a real channel — stored handle
  casing/format ≠ YT canonical. MUST resolve by **channel ID** (parse `/channel/UC…` from
  `profile_url`, or `search.list` then `channels.list?id=`). Have `YOUTUBE_API_KEY`. Medium-high.
- **Facebook**: `followers_count`/`fan_count` needs `pages_read_engagement` AND a **numeric Page
  ID** — stored "handles" are often display names ("MovifiedTamil"→"does not exist") or
  `/share/` URLs. Only recoverable for Pages we administer or can resolve to a numeric ID. Low-med.
  Do NOT claim full FB recovery.
- **X / Snapchat**: no free public follower API. **Manual entry only** — must be clearly labelled.

## Schema (real prod names — Prisma `@map` snake_case)
- `social_accounts`: id, platform_id, handle, display_name, follower_count, profile_url,
  status, last_synced_at, client_name, created_at, updated_at
- `account_growth_snapshots`: id, account_id, date, follower_count, following_count, post_count,
  engagement_rate, created_at
- `platforms`: id, name  (Instagram / Facebook / YouTube / X / Snapchat / Twitter-X / LinkedIn / …)

## Accuracy classification (drives the UI label the user asked for)
Each account resolves to one of:
- **LIVE** — fetched from a platform API within the freshness window (e.g. ≤48h). "Verified accurate."
- **STALE** — was live once but `last_synced_at` older than window. "May be outdated."
- **MANUAL** — never API-synced (`last_synced_at IS NULL`), or platform has no public API
  (X/Snapchat), or public lookup failed (private/renamed). "Manually entered."

## Tasks (subagent-driven; Sonnet implements, Opus reviews each)

1. **IG business_discovery resolver** in `meta-followers.ts` (or sibling) — given handles, return
   `{handle→{followers, mediaCount}}`; fail-open per handle; reuse System User token + one connected
   IG node as requesting node. Unit-test the URL/shape + the "Invalid user id"→skip path.
2. **YouTube by-ID resolver** — resolve stored YT rows to channel ID (parse profile_url `/channel/UC…`,
   else `forHandle`, else `search.list`), then `channels.list?part=statistics&id=` for subs. Fail-open.
3. **FB best-effort resolver** — only where a numeric Page ID is resolvable (administered Pages map
   from `me/accounts`, or `/channel`-style ID in profile_url). Explicitly skip `/share/` + display-name
   rows. No false claims.
4. **Wire into `follower-sync.service.ts`** — after the existing administered-account path, run the
   public-discovery resolvers for still-unsynced rows; set `last_synced_at` + write a snapshot ONLY on
   a real fetch; never overwrite a good value with null (fail-open, matches existing Graph-first pattern).
   Keep IST snapshot date-key (`istMidnight(todayIST())`). No `db:push` (no schema change).
5. **Coverage/accuracy in growth API** — `account-growth.service.ts` `getGrowthOverview()` returns per
   account `syncState: LIVE|STALE|MANUAL` + `lastSyncedAt`, and top-level `{liveCount, staleCount,
   manualCount, liveFollowers, manualFollowers}` so the header can show a freshness note while keeping
   the total.
6. **Frontend `/accounts/growth`** — (a) keep total + freshness note ("X of Y accounts live-synced;
   Z manually tracked"); (b) per-account badge: green "Live" + date, amber "Stale", grey "Manual";
   (c) honest copy. Match existing internal cream/ink palette.

## Constraints / guardrails
- ALWAYS live-probe a new Graph/YT fetcher against the real token before trusting it (mocks lied before
  — see project_link_insights_growth_2026_06_25 IG TWO-STEP). Build+tests green ≠ correct.
- Fail-open everywhere: a resolver throw/empty must keep the prior value, never null it, never block sync.
- Shared ~200-call/hr Meta budget (with link-insights + hourly follower-sync) — batch IG discovery
  (business_discovery is 1 call per handle; consider chunking / spacing; cron already hourly).
- No `db:push`. Verify on prod LIVE after deploy (not just local build).
