# Link Insights Contradictions Fix + Follower Growth Analytics Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** (PR-A) Eliminate every user-visible contradiction across the YouTube / Instagram / Facebook link-insights display surfaces now that Facebook insights are LIVE; (PR-B) replace the fragile IG/FB follower scrape with the Meta Graph API and surface a per-account + org-overview follower-growth view in the internal portal; (PR-C) document — not build — how Snapchat could be connected.

**Architecture:**
- PR-A is **frontend-only** (no `db:push`, no API change). It fixes stale "Facebook pending Meta approval" copy, adds the Facebook Views column (FB *does* fetch `post_video_views`), unifies the two divergent `InsightBadge` components onto the HR version, and normalizes empty-state behavior across all three platforms.
- PR-B reuses existing infrastructure: the `meta-graph.ts` helper (`graphFetch`, `getMetaToken`, `metaConfigured`), the `AccountGrowthSnapshot` table + `account-growth.service.ts` (`getAccountGrowth`/`recordGrowthSnapshot` already exist and are HR-wired). It swaps the IG/FB follower fetchers in `follower-sync.service.ts` to Graph API calls, fixes a latent IST date-key bug in that file, adds **admin** growth routes + an overview aggregation, and builds the internal-portal UI.
- PR-C is a markdown doc only.

**Tech Stack:** Express + Prisma + TypeScript (API), Next.js App Router + SWR + Tailwind + recharts (internal portal), Vitest (API tests). Meta Graph API v21.0 via the existing permanent System User token (`META_SYSTEM_USER_TOKEN` in `apps/api/.env`).

**Branching:** Work on a feature branch off `main` (never commit directly to `main`). PR-A and PR-B are separate branches/PRs; ship PR-A first.

---

## Background facts the executor MUST know (read before starting)

1. **Facebook insights are LIVE** as of 2026-06-24 (PR #37). FB metrics (views for videos, likes, comments, shares) flow into `link_metrics` via the owned-Page `/published_posts` + `/insights` path. **No App Review is needed.** Any UI copy that says "Facebook insights pending Meta approval / requires `pages_read_engagement` App Review" is now **factually wrong**.
2. **Per-platform metric reality** (from the providers — do not change this, just display it correctly):
   - **YouTube**: views ✅, likes ✅, comments ✅, shares ❌ (Data API has none).
   - **Instagram**: views ❌ (provider returns `null` — reels `plays` need a separate `/insights` call not in this build), likes ✅, comments ✅.
   - **Facebook**: views ✅ (videos only, via `post_video_views`), likes ✅, comments ✅, shares ✅.
3. **`fmtCompact(null)` renders `"—"`.** So "show a metric only if non-null" is the rule that avoids fake dashes.
4. **The two `InsightBadge` components are real duplicates** at `apps/internal/src/components/insight-badge.tsx` and `apps/hr/src/components/insight-badge.tsx`. The **HR version is correct** (views-if-present + likes + comments). Internal is wrong (always renders views → fake `—` for IG/FB, and drops comments).
5. **Known limitations that are NOT bugs — do NOT try to "fix" them:** IG/FB ~1% historical coverage (Meta firehose truncation); IG per-post views absent; opaque `facebook.com/share/` links unmatchable. The coverage banner already states these honestly.
6. **IST rule:** all "today" date-key writes must use `istMidnight(todayIST())` from `@dashmani/shared`, never `new Date().toISOString().split("T")[0]` or `setHours(0,0,0,0)` (server is UTC; those drift 12am–5:30am IST). `account-growth.service.ts` already does this correctly; `follower-sync.service.ts` does NOT (PR-B Task 4 fixes it).
7. **Verification commands** (this repo): per-app typecheck `npx tsc --noEmit -p apps/<app>/tsconfig.json`; API tests `npm run test -w @dashmani/api`; full build `npm run build`. Do NOT run `npm run build` while `npm run dev` servers are running (it poisons the `.next` cache).

---

# PR-A — Fix the four display contradictions (frontend-only, ship first)

Branch: `fix/link-insights-display-contradictions`

### Task A1: Unify the internal `InsightBadge` onto the HR version

**Files:**
- Modify: `apps/internal/src/components/insight-badge.tsx` (replace the render body)

**Step 1: Replace the internal badge render to match HR semantics**

Open `apps/internal/src/components/insight-badge.tsx`. Replace the final `return (...)` block (the one starting `<span title={updatedAt ? ...}`) and add the `MessageCircle` import so it renders **views-only-if-present + likes + comments**, identical to `apps/hr/src/components/insight-badge.tsx`:

- Add `MessageCircle` to the `lucide-react` import: `import { Eye, Heart, MessageCircle, Info } from "lucide-react";`
- Add before the return: `const hasViews = metric.views != null;`
- Render: when `hasViews`, show `<Eye/> {fmtCompact(metric.views)} ·`; always show `<Heart/> {fmtCompact(metric.likes)} · <MessageCircle/> {fmtCompact(metric.comments)}`.

(Copy the exact JSX from `apps/hr/src/components/insight-badge.tsx` lines 44-66 — the two files should now be byte-identical except possibly the title fallback string.)

**Step 2: Typecheck**

Run: `npx tsc --noEmit -p apps/internal/tsconfig.json`
Expected: no errors.

**Step 3: Commit**

```bash
git add apps/internal/src/components/insight-badge.tsx
git commit -m "fix(insights): unify internal InsightBadge with HR version (show comments, drop fake — views for IG/FB)"
```

---

### Task A2: Kill the stale "Facebook pending Meta approval" copy in the internal Top-Links panels + normalize empty state

**Files:**
- Modify: `apps/internal/src/app/reports/page.tsx` (the `PLATFORMS` array ~line 540-578 and the panel render ~line 585-676)

**Context:** Right now Facebook has `pendingWhenEmpty: true` and a hardcoded "Facebook insights pending / requires `pages_read_engagement` App Review" empty card. Since FB is live, an empty FB panel just means "no FB links in this window" — same as YouTube/Instagram. Normalize all three.

**Step 1: Remove the Facebook `pendingWhenEmpty` flag and its comment**

In the `PLATFORMS` array, delete the `pendingWhenEmpty: true,` line (and the 4-line `// Facebook content is currently blocked...` comment above it) from the facebook entry. Facebook should now be structurally identical to youtube/instagram except for label/icon/metric.

**Step 2: Remove the now-dead pending-state branch**

In the panel render, delete the `isPending` computation (`const isPending = p.pendingWhenEmpty && ...`) and the entire `) : isPending ? ( ... )` JSX branch (the Clock icon + "Facebook insights pending" card). Simplify the empty-hide guard to: `if (!p.loading && p.data.length === 0) return null;` (drop the `&& !p.pendingWhenEmpty`). Update the `willRender`/`toggleAnchorKey` logic to drop the `|| p.pendingWhenEmpty` term.

**Step 3: Typecheck**

Run: `npx tsc --noEmit -p apps/internal/tsconfig.json`
Expected: no errors (watch for an unused `Clock` import — remove it if `Clock` is no longer referenced anywhere in the file).

**Step 4: Commit**

```bash
git add apps/internal/src/app/reports/page.tsx
git commit -m "fix(insights): drop stale 'Facebook pending Meta approval' state — FB insights are live (PR #37)"
```

---

### Task A3: Show the Facebook Views column when FB data has views

**Files:**
- Modify: `apps/internal/src/app/reports/page.tsx` (the `showViewsCol` logic ~line 592)
- Modify: `apps/api/src/services/social-insights.service.ts` (`getTopLinksByPlatform` default sort — optional, see Step 2)

**Context:** `showViewsCol = p.metric === "views"` is true only for YouTube. But Facebook **does** populate `views` for video posts. We want the Views column to appear for Facebook too — but render `fmtCompact(link.views)` which is `"—"` for non-video FB posts (honest, since not every FB post is a video). Instagram genuinely has no views, so it should stay 5-column.

**Step 1: Make `showViewsCol` per-platform, not metric-keyed**

Change the panel definition so each platform declares whether it has a views column. In the `PLATFORMS` array add `showViews: true` to youtube and facebook, `showViews: false` to instagram. Then in the render replace `const showViewsCol = p.metric === "views";` with `const showViewsCol = p.showViews;`. The grid-cols ternary and the header/row `{showViewsCol && ...}` guards already do the right thing once `showViewsCol` is true for FB.

**Step 2 (optional, recommended): sort Facebook by views when it has them**

In `apps/api/src/services/social-insights.service.ts`, `getTopLinksByPlatform` currently defaults FB to `engagement` sort. Leave the default as-is (engagement is a safe sort because many FB posts have null views). Do NOT change the sort — the column just needs to *display*. Skip this step unless you specifically want views-sorted FB; if so, it must tolerate null views (the existing `score` fn already does `s.views ?? 0`).

**Step 3: Typecheck**

Run: `npx tsc --noEmit -p apps/internal/tsconfig.json`
Expected: no errors.

**Step 4: Commit**

```bash
git add apps/internal/src/app/reports/page.tsx
git commit -m "feat(insights): show Facebook Views column (FB videos report post_video_views)"
```

---

### Task A4: Fix the HR report panel subtitle (drop "Facebook pending Meta approval")

**Files:**
- Modify: `apps/hr/src/app/report/page.tsx` (~line 1196-1212, the "Your link insights" panel)

**Step 1: Rewrite the subtitle to be platform-honest**

Replace the subtitle text (currently "Views, likes & comments for your YouTube and Instagram links. Facebook insights are pending Meta approval and will appear here once available.") with something like: "Views, likes & comments for your YouTube, Instagram and Facebook links. Updated every 6h." Also update the adjacent code comment (~line 1196-1197) that says "Facebook joins automatically once Meta App Review unblocks it" — replace with "all three platforms covered".

**Step 2: Typecheck**

Run: `npx tsc --noEmit -p apps/hr/tsconfig.json`
Expected: no errors.

**Step 3: Commit**

```bash
git add apps/hr/src/app/report/page.tsx
git commit -m "fix(hr): drop stale 'Facebook pending Meta approval' subtitle — FB insights are live"
```

---

### Task A5: Grep-sweep for any remaining stale "pending Meta / App Review" copy

**Step 1: Search the whole repo (excluding build caches)**

Run:
```bash
grep -rn -i "pending Meta\|Meta App Review\|App Review\|pages_read_engagement" apps/ packages/ --include="*.tsx" --include="*.ts" | grep -v ".next"
```
Expected: the only remaining hits should be in **backend comments** that explain the *provider* architecture (those are accurate historical context and fine to keep), and possibly the `getTopLinksByPlatform` comment in `social-insights.service.ts`. Update any **user-facing string** still claiming FB is unavailable. Do NOT touch comments that merely document why the owned-Page path is used.

**Step 2: If any user-facing string was changed, typecheck the affected app and commit.**

---

### Task A6: PR-A verification + open PR

**Step 1: Full typecheck of all three touched apps**

Run:
```bash
npx tsc --noEmit -p apps/internal/tsconfig.json && npx tsc --noEmit -p apps/hr/tsconfig.json
```
Expected: no errors.

**Step 2: Full build (only if no dev servers are running)**

Run: `npm run build`
Expected: all apps build. (If dev servers are up, skip and rely on per-app tsc — see Background fact 7.)

**Step 3: Manual visual check (optional but recommended)**

Start dev (`npm run dev`), log into the internal portal `/reports`, confirm: (a) no "Facebook pending" card; (b) Facebook panel shows a Views column; (c) Instagram panel has no Views column and its badges show likes + comments (no `👁 —`). Confirm HR `/report` subtitle no longer says "pending Meta approval".

**Step 4: Push + open PR**

```bash
git push origin fix/link-insights-display-contradictions
gh pr create --title "fix(insights): remove FB-pending contradictions, unify metric badges, show FB views" --body "<summary of A1-A5>"
```

**No `db:push` required for PR-A.**

---

# PR-B — Meta Graph API follower swap + internal growth UI

Branch: `feat/follower-growth-graph-api` (open AFTER PR-A merges)

**Architecture note:** The data model (`AccountGrowthSnapshot`), the read service (`getAccountGrowth`), and the daily-snapshot write (in `follower-sync.service.ts`) all already exist. PR-B (1) makes the IG/FB follower *source* reliable via Graph API, (2) fixes the IST date-key bug in the snapshot write, (3) adds admin-scoped growth routes + an org overview, (4) builds the internal UI. No new table → **no `db:push`** unless we choose to also start writing `followingCount`/`postCount` (those columns already exist, so still no migration).

### Task B1: Add Graph-API follower fetchers to the meta layer (TDD)

**Files:**
- Create: `apps/api/src/services/social-insights/meta-followers.ts`
- Test: `apps/api/src/services/social-insights/__tests__/meta-followers.test.ts` (match the existing provider test location/pattern — check where `instagram.provider` tests live and mirror it)

**Context:** Reuse `graphFetch`, `getMetaToken`, `metaConfigured`, `GRAPH_BASE` from `./meta-graph`. Endpoints (read with the System User token, scopes already granted):
- **Instagram:** discover IG business account ids via `GET /me/accounts?fields=instagram_business_account{id,username,followers_count}` OR per-account `GET /{ig-user-id}?fields=followers_count,media_count,follows_count`. Return a `Map<username, {followers, following?, posts?}>`.
- **Facebook:** per administered Page `GET /{page-id}?fields=followers_count,fan_count` (prefer `followers_count`; fall back to `fan_count`). Return a `Map<pageId|slug, {followers}>`. (You already have the page-discovery pattern in `facebook.provider.ts` via `/me/accounts?fields=id,access_token,tasks` — reuse that shape.)

**Step 1: Write the failing test** — inject a mock `graphFetch` (the helper is injectable per its doc comment). Assert that given a mock IG response `{ data: [{ instagram_business_account: { username: "x", followers_count: 1234 } }] }`, `fetchInstagramFollowerMap(mockFetch)` resolves a map with `x → 1234`. Add a parallel FB test for `fetchFacebookFollowerMap`.

**Step 2: Run** `npm run test -w @dashmani/api -- meta-followers` → Expected: FAIL (module not found).

**Step 3: Implement** `meta-followers.ts` with `fetchInstagramFollowerMap(graphFetch?)` and `fetchFacebookFollowerMap(graphFetch?)`, both honoring the `rateLimited` sentinel (stop early, return partial map) and returning `null`/empty gracefully when `!metaConfigured()`.

**Step 4: Run tests** → Expected: PASS.

**Step 5: Commit** `git commit -m "feat(followers): Meta Graph API follower-count fetchers (IG followers_count, FB followers_count/fan_count)"`

---

### Task B2: Swap `follower-sync.service.ts` IG/FB to the Graph API (keep scrape as fallback)

**Files:**
- Modify: `apps/api/src/services/follower-sync.service.ts`

**Context:** Replace the unofficial IG `web_profile_info` fetch and the FB Googlebot scrape with the Graph API map from B1, **falling back to the existing scrapers only if the Graph map has no entry** for that account (so accounts not reachable by the System User token still get a best-effort number). This is additive reliability, not a removal.

**Step 1:** At the top of `syncAllFollowerCounts()`, before the account loop, build the Graph maps once: `const igMap = await fetchInstagramFollowerMap(); const fbMap = await fetchFacebookFollowerMap();` (guarded so a thrown error leaves them empty and the loop falls back to scraping).

**Step 2:** In the loop, for `slug === "instagram"`: look up `igMap.get(username)` first; if present use it (no `sleep` needed — it was one batched call); else fall back to `fetchInstagramFollowers(username)` + `sleep`. Same pattern for `slug === "facebook"` with `fbMap`. YouTube unchanged.

**Step 3:** Apply the same Graph-first logic in `syncSingleAccountFollowers()` (build a single-entry lookup or just call the existing scrapers as fallback — for a single account it's fine to call the Graph fetchers directly or reuse the map fetch).

**Step 4: Typecheck** `npx tsc --noEmit -p apps/api/tsconfig.json` → Expected: no errors.

**Step 5: Commit** `git commit -m "feat(followers): use Meta Graph API for IG/FB follower counts, scrape only as fallback"`

---

### Task B3: Fix the latent IST date-key bug in `follower-sync.service.ts` (TDD-lite)

**Files:**
- Modify: `apps/api/src/services/follower-sync.service.ts` (lines ~252-253 and ~346-347)

**Context:** The snapshot write keys on `const today = new Date(); today.setHours(0,0,0,0);` — that's **server-local (UTC) midnight**, which drifts vs IST 12am–5:30am and disagrees with `account-growth.service.ts` (which uses `istMidnight(todayIST())`). On the UTC Linode this can write to the wrong calendar day or create a duplicate row. Fix both occurrences to use the shared IST helper.

**Step 1:** Add import: `import { todayIST, istMidnight } from "@dashmani/shared";`

**Step 2:** Replace both `const today = new Date(); today.setHours(0, 0, 0, 0);` blocks with `const today = istMidnight(todayIST());`.

**Step 3: Typecheck** → Expected: no errors. **Run** `npm run test -w @dashmani/api` to confirm no regressions.

**Step 4: Commit** `git commit -m "fix(followers): key daily growth snapshot on IST midnight (was UTC, drifted 12am-5:30am IST)"`

---

### Task B4: Add admin growth routes + org overview aggregation (TDD)

**Files:**
- Modify: `apps/api/src/services/account-growth.service.ts` (add `getGrowthOverview`)
- Modify: `apps/api/src/routes/admin-reports.routes.ts` (add `GET /admin/growth` overview + `GET /admin/growth/:accountId`)
- Test: add to the existing account-growth test file if one exists, else create `apps/api/src/services/__tests__/account-growth.test.ts`

**Context:** HR already has `/hr/growth` (employee-scoped). The internal portal needs **admin-scoped, org-wide** routes guarded by `requirePermission("accounts","view")` (or `"reports","view"` — match whatever the accounts page already uses).

**Step 1: Write failing test for `getGrowthOverview(days)`** — it should return, per active account: latest followerCount, the followerCount `days` ago (or earliest snapshot if fewer), and the delta + delta%. Plus org totals (sum of latest followers, total delta) and a `topMovers` list (largest absolute gainers/losers). Seed two accounts with two snapshots each; assert deltas.

**Step 2: Run** → FAIL.

**Step 3: Implement `getGrowthOverview(days = 30)`** in `account-growth.service.ts`: load active `SocialAccount`s with their snapshots in window (`orderBy date asc`), compute first/last per account, delta = last - first, deltaPct = first>0 ? round(delta/first*100) : null. Return `{ totalFollowers, totalDelta, accounts: [{accountId, displayName, platform, latest, delta, deltaPct, snapshots}], topMovers }`. Keep it bounded (don't return more than e.g. 60 snapshot points per account — sample like the reports trend cap does).

**Step 4: Run** → PASS.

**Step 5: Add the routes** in `admin-reports.routes.ts` (these MUST be declared before any `/:reportId`-style catch — group them with the other `/admin/growth/record` route already there). `GET /admin/growth?days=30` → `getGrowthOverview`; `GET /admin/growth/:accountId?days=30` → existing `getAccountGrowth`.

**Step 6: Typecheck + test** → Expected: no errors, tests pass.

**Step 7: Commit** `git commit -m "feat(growth): admin org-overview + per-account growth routes"`

---

### Task B5: Internal portal growth UI — hook + overview page

**Files:**
- Create: `apps/internal/src/lib/hooks/use-growth.ts` (SWR hooks `useGrowthOverview(days)`, `useAccountGrowth(accountId, days)`)
- Create: `apps/internal/src/app/accounts/growth/page.tsx` (org overview) OR add a section to `apps/internal/src/app/accounts/page.tsx` — pick per existing nav structure
- Modify: `apps/internal/src/app/accounts/[id]/page.tsx` (add per-account trend chart)
- Modify: sidebar nav (the internal sidebar component) to add a "Account Growth" entry under the Analytics section

**Context:** Match existing SWR conventions in `use-reports.ts` (fetcher unwraps `.data`; `revalidateOnFocus:false`, sensible `dedupingInterval`). Charts use `recharts` (already a dependency — see the reports BarChart/AreaChart usage). Use the cream/ink palette consistent with `/reports`.

**Step 1:** Build `use-growth.ts` mirroring `useTopLinks` in `use-reports.ts` (SWR key `/admin/growth?days=${days}` and `/admin/growth/${accountId}?days=${days}`).

**Step 2:** Build the overview page: a stat row (Total Followers across accounts, Net change in window with ▲/▼), a "Top Movers" list (gainers green ▲, losers red ▼ with delta + delta%), and a sortable table of accounts (name, platform pill, current followers, Δ, Δ%). Each row links to the account detail.

**Step 3:** On the account detail page, add a follower-trend chart (recharts `AreaChart` or `LineChart` over `snapshots`), the current count, and the window delta with ▲/▼. Add a small window-pill set (7d/30d/90d) consistent with the reports pages.

**Step 4:** Add the sidebar nav entry.

**Step 5: Typecheck** `npx tsc --noEmit -p apps/internal/tsconfig.json` → Expected: no errors.

**Step 6: Commit** `git commit -m "feat(growth): internal portal follower-growth overview + per-account trend UI"`

---

### Task B6: PR-B verification + deploy notes

**Step 1: API tests + typecheck**

Run: `npm run test -w @dashmani/api && npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/internal/tsconfig.json`
Expected: green.

**Step 2: Full build** (no dev servers running): `npm run build`.

**Step 3: Manual check** — internal `/accounts/growth` shows real numbers; per-account chart renders; trigger `POST /accounts/sync-followers` and confirm IG/FB counts now come from the Graph API (check server logs for the new fetch path, and that counts are plausible vs the old scrape).

**Step 4: Push + PR.** In the PR body note: **no `db:push` required** (no schema change — `followingCount`/`postCount`/`engagementRate` columns already exist). Note the IST date-key fix. Confirm `META_SYSTEM_USER_TOKEN` is already in prod `apps/api/.env` (it is, per CLAUDE.md).

---

# PR-C — Snapchat connection steps (documentation only)

### Task C1: Write the Snapchat feasibility + connection-steps doc

**Files:**
- Create: `docs/SNAPCHAT-CONNECTION-STEPS.md`

**Content the doc must cover (write it AFTER PR-A and PR-B are done so it can reference the real, finished YouTube/Meta patterns as the template):**

1. **Reality check up front:** Snapchat has **no public follower/subscriber count** and **no official read API** for organic Story/Spotlight views/likes/comments. The Snap Marketing API and Conversions API are **ads-only**. So Snapchat cannot be auto-connected the way YouTube (Data API) and IG/FB (Graph API) are. State this plainly so nobody re-attempts a scraper (Snapchat is a client-rendered app behind auth — same trap as TikTok, documented in `follower-sync.service.ts`).
2. **What IS possible today:** manual entry only — the same fallback already used for TikTok/LinkedIn/Twitter followers (`follower-sync.service.ts` skips those; admins enter counts via the per-row pencil on the accounts page). Document the exact steps to enable a Snapchat account this way (add a `snapchat` Platform row if absent; manual follower entry; manual metric entry per link if desired).
3. **The hypothetical "if Snap ever ships a read API" playbook**, written as a mirror of the YouTube/Meta provider pattern so it's drop-in when/if possible:
   - Add `"snapchat"` to `SUPPORTED_INSIGHT_PLATFORMS` in `packages/shared/src/utils/social-insights.ts` (the single switch).
   - Add a `snap:` branch to `canonicalKey()` in `packages/shared/src/utils/canonical-url.ts` (extract the Spotlight/Story id; keep the opaque-fallthrough discipline).
   - Add `extractSnapchatPostId()` to the shared extractors.
   - Create `apps/api/src/services/social-insights/snapchat.provider.ts` implementing the same `fetchBatch` + optional `harvestContent` interface as the other providers, gated on a `SNAPCHAT_TOKEN` env var (dark-switch, like `metaConfigured()`).
   - Register it in `registry.ts`. The cron, `link_metrics`, the Top-Links panel (`useTopLinks("snapchat", ...)`), and the coverage banner all pick it up with near-zero extra code (the generalized `getTopLinksByPlatform` + `useTopLinks` already accept any platform string).
   - For followers: add a `fetchSnapchatFollowerMap` to `meta-followers.ts`'s sibling pattern and a `slug === "snapchat"` branch in `follower-sync.service.ts`.
4. **Recommendation:** manual entry now; revisit only if Snap publishes an organic-content read API. No engineering work scheduled.

**Step 1: Write the doc. Step 2: Commit** `git commit -m "docs: Snapchat connection steps + feasibility (manual-entry only; no read API exists)"`

---

## Decision Log

- **All 4 display issues in scope (not just the FB copy):** the user asked for zero contradictions; the badge divergence and FB-views gap are equally user-visible. — chosen over "just #1".
- **Graph API swap BEFORE growth UI:** a growth chart over scraped (unreliable) numbers would visualize noise; fixing the source first makes the chart trustworthy from day one. — chosen over "UI first".
- **Three separate PRs, display fixes first:** the contradiction fixes are urgent, low-risk, and frontend-only; they shouldn't wait on the larger analytics change. — chosen over one combined PR.
- **Internal portal, per-account + overview for growth UI** (not client-facing yet) — chosen to keep auth surface small; client-scoped growth can follow later.
- **Snapchat: document, don't build** — no usable API exists; manual entry is the only real option. The doc gives a drop-in playbook if that ever changes.
- **No `db:push` in either PR:** PR-A is frontend-only; PR-B reuses the existing `AccountGrowthSnapshot` table and already-present columns.
- **Keep scrapers as fallback (B2):** Graph API only reaches accounts the System User token administers; scrape fallback preserves best-effort coverage for the rest.

## Risks & mitigations

- **Graph API doesn't cover every account** (token only sees administered Pages / connected IG business accounts): mitigated by scrape fallback (B2) — net strictly better than today.
- **Meta rate limits** (codes 4/17/32/613): the `graphFetch` sentinel already short-circuits; follower maps are one batched call each, far under the ~200/hr budget.
- **IST date drift** double-writing snapshots: fixed in B3; the `@@unique([accountId, date])` constraint plus consistent `istMidnight` keying makes the upsert idempotent.
- **`npm run build` poisoning `.next`** while dev runs: Background fact 7 — use per-app `tsc` for verification during dev.
