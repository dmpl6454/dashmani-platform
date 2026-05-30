# Social Media Link Insights — Implementation Plan

**Status:** ✅ Approved — all §11 open questions resolved by user 2026-05-30
**Date:** 2026-05-30
**Author:** Plan agent
**Scope:** v1 = YouTube only, architected for Instagram + Facebook later

## ✅ Locked-in decisions (from §11)

| # | Decision | Choice |
|---|---|---|
| 1 | FK strategy for `link_metrics.linkId` | **Nullable + SetNull + denormalize + re-heal** |
| 2 | Polling window cutoff | **60 days** |
| 3 | Cron mechanism | **`setInterval` every 6h from API boot** |
| 4 | Denormalize `videoId` onto `ReportLink` | **No — extract on the fly** |
| 5 | Engagement card placement on `/reports` | **5th card on existing strip** |
| 6 | "Top performing" sort (for `/reports/links` panel only) | **Views descending** |
| 7 | Leaderboard ranking | ⚠️ **Unchanged — stays as "most links submitted"**. No engagement-based ranking added. |
| 8 | Empty-state copy | **"Insights not yet supported for [Platform]"** |
| 9 | Snapshot retention | **Keep all forever** (v1) |
| 10 | YouTube quota tracking | **None for v1** |
| 11 | HR panel visibility | **Hide entirely if no YouTube links in last 30 days** |

---

## 1. Architecture Overview

### Provider pattern

A new directory `apps/api/src/services/social-insights/` houses:

```
social-insights/
  types.ts              # InsightProvider interface, FetchResult shape
  registry.ts           # platform-slug → provider lookup + isSupported()
  youtube.provider.ts   # v1 — only file with real impl
  instagram.provider.ts # later — stub today (throws "not implemented")
  facebook.provider.ts  # later — stub today
  index.ts              # re-exports registry + provider type
```

Common interface (`types.ts`):

```ts
export interface InsightFetchResult {
  ok: boolean;
  status: "ok" | "not_found" | "private" | "rate_limited" | "error";
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  raw?: Record<string, unknown>;
  error?: string;
}

export interface InsightProvider {
  slug: string;                                  // "youtube" | "instagram" | ...
  isSupported(): boolean;                        // honest signal — false for IG/FB until OAuth done
  extractTargetId(url: string): string | null;   // YouTube videoId, IG mediaId, etc.
  fetchBatch(targets: { linkId: string; url: string; videoId: string }[]):
    Promise<Map<string, InsightFetchResult>>;    // linkId → result
}
```

Registry (`registry.ts`) exposes `getProvider(slug)` and `getSupportedSlugs()`. Cron and frontend both call into the registry — there is one source of truth for "which platforms have insights today".

### Shared package contract

`packages/shared/src/utils/social-insights.ts` exports:

```ts
export const SUPPORTED_INSIGHT_PLATFORMS = ["youtube"] as const;
export type SupportedInsightPlatform = typeof SUPPORTED_INSIGHT_PLATFORMS[number];
export function isPlatformInsightSupported(platform: string | null | undefined): boolean;
export function getSupportedInsightPlatforms(): readonly string[];
```

This is the **single switch** — flipping `SUPPORTED_INSIGHT_PLATFORMS` to `["youtube", "instagram"]` later auto-updates both the cron skip-list and every frontend badge/tooltip. Re-exported from [packages/shared/src/index.ts](../packages/shared/src/index.ts).

The YouTube ID extractor lives next to it at `packages/shared/src/utils/youtube.ts` (usable by API cron and any frontend preview later).

---

## 2. Schema Changes

### New table: `link_metrics`

Add to [packages/db/prisma/schema.prisma](../packages/db/prisma/schema.prisma):

```prisma
model LinkMetric {
  id              String   @id @default(uuid())
  // Nullable FK so a metric snapshot survives a ReportLink delete-and-recreate
  linkId          String?  @map("link_id")

  // Denormalised so analytics keep working when linkId is null after a resubmit
  employeeId      String   @map("employee_id")
  reportDate      DateTime @db.Date              @map("report_date")
  url             String                                            // raw + normalised on insert
  urlNormalized   String   @map("url_normalized")                   // lowercased, trimmed
  platform        String                                            // "youtube" (lowercase)
  videoId         String?  @map("video_id")                         // YouTube videoId (or null)

  // Metric snapshot
  fetchedAt       DateTime @default(now()) @map("fetched_at")
  status          String                                            // "ok" | "not_found" | "private" | "error"
  views           Int?
  likes           Int?
  comments        Int?
  shares          Int?
  errorMessage    String?  @map("error_message")

  link            ReportLink? @relation(fields: [linkId], references: [id], onDelete: SetNull)
  employee        User        @relation(fields: [employeeId], references: [id], onDelete: Cascade)

  @@index([employeeId, reportDate])
  @@index([urlNormalized])
  @@index([linkId])
  @@index([platform, fetchedAt])
  @@map("link_metrics")
}
```

Add the reverse relations to `ReportLink` and `User` — `metrics LinkMetric[]`.

### FK choice — recommendation: **nullable FK + denormalize**

Rationale:
- `POST /hr/reports` uses **delete-and-recreate** semantics ([daily-report.service.ts](../apps/api/src/services/daily-report.service.ts)). A hard `Cascade` would wipe metric history every time an employee resubmits today's report.
- `SetNull` keeps the snapshots queryable but loses the link. **Denormalising `employeeId`, `reportDate`, `url`, `urlNormalized`, `platform`, `videoId`** keeps every analytics query alive without the FK.

### Metric continuity across resubmits

Two mechanisms:

1. **Cron self-heals the FK.** On every cron run, after upserting today's snapshot, run a quick re-link query:

   ```sql
   -- For metrics with linkId=null, try to attach them to a current ReportLink
   -- matching (employeeId, reportDate, urlNormalized).
   UPDATE link_metrics m
   SET link_id = rl.id
   FROM report_links rl
   JOIN daily_reports dr ON dr.id = rl.report_id
   WHERE m.link_id IS NULL
     AND m.employee_id = dr.employee_id
     AND m.report_date = dr.date
     AND m.url_normalized = LOWER(TRIM(rl.url));
   ```

2. **Cron polls by URL, not linkId.** When we resolve the polling target list (see §4), we group by `urlNormalized` and use the **freshest live `ReportLink.id`** as the candidate. New `ReportLink` UUIDs after a resubmit just become the new owner; the historical snapshots are linked back via the re-heal query.

### Migration mechanics (per CLAUDE.md convention)

- Schema changes use **`db:push`**, not `prisma migrate` (per [CLAUDE.md](../CLAUDE.md)).
- Changes are **purely additive**: one new table + one nullable FK column. No `DROP COLUMN`, no FK delete-rule changes on existing columns. Safe to `db:push` on prod after diff verification.
- After deploy, SSH to Linode: `cd /opt/dashmani-platform && npm run db:generate && npm run db:push`.

---

## 3. YouTube Provider Implementation

### `extractVideoId()` util — `packages/shared/src/utils/youtube.ts`

Handles all real-world YouTube URL shapes:

| Shape | Example | Strategy |
|-------|---------|----------|
| `youtube.com/watch?v=ID` | `https://www.youtube.com/watch?v=dQw4w9WgXcQ` | parse `v` query param |
| `youtu.be/ID` | `https://youtu.be/dQw4w9WgXcQ?t=10` | first path segment |
| `youtube.com/shorts/ID` | `https://www.youtube.com/shorts/abc123` | path segment after `/shorts/` |
| `youtube.com/embed/ID` | `https://www.youtube.com/embed/abc123` | path segment after `/embed/` |
| `youtube.com/live/ID` | `https://www.youtube.com/live/abc123` | path segment after `/live/` |
| `m.youtube.com/...` | mobile variant | strip `m.` host, recurse |
| With `&t=`, `&list=`, etc. | `?v=ID&t=10s` | URL-parsed, robust |

Implementation uses `new URL()` (Node + browser safe), returns `null` for non-YouTube hosts. Add a vitest in `packages/shared/__tests__/youtube.test.ts` covering all the shapes above plus invalid input (empty string, non-URL, wrong host, missing video param).

### YouTube provider — `apps/api/src/services/social-insights/youtube.provider.ts`

API call shape (single endpoint, batched):

```
GET https://www.googleapis.com/youtube/v3/videos
    ?part=statistics
    &id=<comma-separated up to 50 ids>
    &key=<YOUTUBE_API_KEY>
```

- **Quota:** 1 unit per call, 10,000 units/day default → ~500K videos/day capacity. Plenty.
- **Batch size:** 50 per request (YouTube's hard cap).
- **Parse:** Response items have `id` + `statistics.{viewCount, likeCount, commentCount}` as strings → `parseInt`. **No dislike count** (YouTube removed it). No `shares` field (always null).
- **Missing item:** If a videoId is in the request but absent from response `items[]`, it's deleted/private/unlisted → write `status: "not_found"`, all metric fields null.

### Error handling matrix

| Outcome | What we write |
|---------|---------------|
| HTTP 200, item present | `status: "ok"`, views/likes/comments populated |
| HTTP 200, item missing from items | `status: "not_found"`, metrics null |
| HTTP 403 with `quotaExceeded` reason | abort the entire run, log + alert, **no DB writes** for remaining batches (don't poison snapshots) |
| HTTP 403 with `keyInvalid` | abort, log loud — config issue |
| HTTP 5xx / network timeout (10s) | mark the batch as failed, write `status: "error"` with errorMessage |
| `extractVideoId` returns null | skip the link — log warn (shouldn't happen for live YouTube links) |

### `videoId` denormalisation onto `ReportLink`?

**Open question for §11.** Adding `ReportLink.videoId String?` saves the extractor call on every cron tick and makes the platform-slug-derived-from-URL more reliable. Trade-off: another nullable column + backfill on first cron run. **Recommendation: skip for v1**, the extractor is microsecond-cheap.

---

## 4. Cron Job

### File: `apps/api/src/cron/social-insights.cron.ts`

### Bootstrap pattern (matches existing convention)

The repo doesn't use `node-cron`. The existing follower sync uses `setInterval` from [apps/api/src/index.ts](../apps/api/src/index.ts):

```ts
app.listen(PORT, () => {
  const runFollowerSync = () => { syncAllFollowerCounts().catch(...); };
  runFollowerSync();
  setInterval(runFollowerSync, 60 * 60 * 1000);
});
```

Add an analogous block for social insights — **every 6 hours = 21,600,000 ms**:

```ts
import { runSocialInsightsRefresh } from "./cron/social-insights.cron";
// inside app.listen:
const runSocialInsights = () => {
  runSocialInsightsRefresh().catch((err) => console.error("[social-insights] error:", err));
};
// Run once on boot, then every 6 hours
runSocialInsights();
setInterval(runSocialInsights, 6 * 60 * 60 * 1000);
```

**No cron expression in IST/UTC** — `setInterval` is timer-relative, not wall-clock, which sidesteps the IST/UTC ambiguity entirely.

### Polling logic

```ts
export async function runSocialInsightsRefresh() {
  const startedAt = Date.now();
  const POLL_WINDOW_DAYS = 60;  // see §11
  const since = new Date(Date.now() - POLL_WINDOW_DAYS * 86400000);

  for (const slug of getSupportedSlugs()) {
    const provider = getProvider(slug);
    if (!provider?.isSupported()) continue;

    // 1. Get distinct (linkId, url) for this platform within the polling window.
    //    Lowercase platform per repo convention.
    const rows = await prisma.reportLink.findMany({
      where: {
        platform: { equals: slug, mode: "insensitive" },
        url: { not: null },
        isScheduled: false,
        report: { date: { gte: since } },
      },
      select: {
        id: true, url: true,
        report: { select: { employeeId: true, date: true } },
      },
    });

    // 2. Dedupe by urlNormalized + extract videoId
    const targets = rows
      .map((r) => {
        const url = r.url!.trim();
        const videoId = provider.extractTargetId(url);
        return videoId ? {
          linkId: r.id, url,
          urlNormalized: url.toLowerCase(),
          videoId,
          employeeId: r.report.employeeId,
          reportDate: r.report.date,
        } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    // 3. Batch by 50, fetch, write snapshots — per-batch try/catch isolates failures
    for (const batch of chunk(targets, 50)) {
      try {
        const results = await provider.fetchBatch(batch);
        for (const t of batch) {
          const r = results.get(t.linkId);
          if (!r) continue;
          await prisma.linkMetric.create({
            data: {
              linkId: t.linkId,
              employeeId: t.employeeId,
              reportDate: t.reportDate,
              url: t.url,
              urlNormalized: t.urlNormalized,
              platform: slug,
              videoId: t.videoId,
              status: r.status,
              views: r.views ?? null,
              likes: r.likes ?? null,
              comments: r.comments ?? null,
              shares: r.shares ?? null,
              errorMessage: r.error ?? null,
            },
          });
        }
      } catch (err) {
        console.error(`[social-insights/${slug}] batch failed:`, err);
        // continue with next batch — one bad batch does not kill the run
      }
    }

    // 4. Re-heal: re-link orphaned snapshots after resubmits
    await prisma.$executeRaw`
      UPDATE link_metrics m
      SET link_id = rl.id
      FROM report_links rl
      JOIN daily_reports dr ON dr.id = rl.report_id
      WHERE m.link_id IS NULL
        AND m.employee_id = dr.employee_id
        AND m.report_date = dr.date
        AND m.platform = ${slug}
        AND m.url_normalized = LOWER(TRIM(rl.url))
    `;
  }

  console.log(`[social-insights] done in ${Date.now() - startedAt}ms`);
}
```

### Per-run summary log (matches follower-sync convention)

```
[social-insights] starting at <ISO>
[social-insights] youtube: 247 links → 234 polled, 9 not_found, 4 errors (3 batches, 3 quota units)
[social-insights] done in 4823ms
```

### Failure isolation

- **Batch-level try/catch** — one 5xx response does not skip the rest.
- **Per-link safety** — even within a batch, a malformed item is skipped (provider returns `error` status, not throws).
- **Quota-exceeded** abort — provider sets a `quotaExceeded` flag; cron exits the for-loop, no further writes that day. Next run resumes from scratch (since the polling list is recomputed every run, not stored).

---

## 5. API Endpoints

All new endpoints use the existing `{success, data}` envelope via `success(res, ...)` from `src/utils/response.ts`.

### Admin endpoints — `apps/api/src/routes/admin-reports.routes.ts`

```
GET  /admin/reports/links/:linkId/metrics
     → InsightSnapshot[]: full history for one link, ordered fetchedAt ASC.
     RBAC: requirePermission("reports", "view")

GET  /admin/reports/insights-summary?startDate&endDate&employeeId?
     → {
         totalViews, totalLikes, totalComments,
         supportedPlatforms: ["youtube"],
         topLinks: [{ linkId, url, employeeId, employeeName, latestViews, latestLikes, ... }],
         byPlatform: [{ platform, totalViews, totalLikes, linkCount, supported }],
       }
     RBAC: requirePermission("reports", "view")
     - Uses denormalised employeeId + reportDate in link_metrics (avoids needing live ReportLink).
     - Window-aware (matches existing RangePills behavior).
     - employeeId param scopes to one employee (matches /admin/reports/employee-stats pattern).
     - For each platform without a supported provider, includes it with supported:false.

GET  /admin/reports/top-youtube-links?startDate&endDate&limit=20
     → [{ linkId, url, videoId, employeeId, employeeName, views, likes, comments, fetchedAt }]
     RBAC: requirePermission("reports", "view")
     - Drives the "Top YouTube links" panel on /reports/links.
     - "Latest snapshot per linkId" via DISTINCT ON (link_id) ORDER BY fetched_at DESC.
```

### HR endpoints — `apps/api/src/routes/hr.routes.ts`

```
GET  /hr/reports/my-link-insights?days=30
     → [{ linkId, url, platform, supported, latest: { views, likes, comments, fetchedAt } | null }]
     - Self-scoped via req.user!.userId — no employeeId param accepted (matches /hr/reports pattern).
     - Returns ALL of the employee's links in window; supported:false rows have latest:null
       so the UI can show the honest "Insights not yet supported for [Platform]" tooltip.
     - Authentication: authenticateHr (so token type check + 403 if wrong portal).
```

### Public-endpoint hygiene

These endpoints are all behind `authenticate` / `authenticateHr` — not public. Still, per CLAUDE.md:
- Use explicit `select` clauses for any nested employee data (return `{ id, name, profileImageUrl }`, never spread).
- Never return `createdBy*` fields.
- The `linkId` exposed in admin responses is a UUID — fine, that's the existing pattern in `/admin/reports`.

### ApiEnvelope consistency

Every response: `success(res, data)` → `{ success: true, data }`. Errors via `next(new AppError(...))`. Match the pattern in [admin-reports.routes.ts](../apps/api/src/routes/admin-reports.routes.ts) exactly.

---

## 6. Frontend — Internal Portal

### `apps/internal/src/app/reports/page.tsx`

Add one stat card to the strip:

```ts
{ title: "Engagement",
  value: insightsLoading ? "—" : formatCompact(insights?.totalViews ?? 0),
  icon: Eye, iconColor: "text-rose-600",
  bgColor: "bg-rose-50 shadow-...",
  sub: `${insights?.totalLikes ?? 0} likes · ${insights?.totalComments ?? 0} comments`,
  clickable: true }
```

- Hook: `useInsightsSummary(startDate, endDate, employeeId)` — added to `apps/internal/src/lib/hooks/use-reports.ts`.
- **Follows the active window pill** — re-fetches on `startDate`/`endDate` change like every other stat (this is non-negotiable, see CLAUDE.md "windowed pills" note).
- **Honors `employeeId` filter** — if the employee is selected, scope to that employee. Reuse the `isEmployeeView` derivation from [reports/page.tsx](../apps/internal/src/app/reports/page.tsx).
- When `viewTotalLinks > 0` but all submitted links are on unsupported platforms (no YouTube), render the card greyed out with `"—"` and subtitle `"Insights not yet supported for [Instagram, Facebook]"`. Computed from `insights.byPlatform.filter(p => !p.supported)`.

### `apps/internal/src/app/reports/[employeeId]/page.tsx`

Extend stats strip — add one card "Total Views" and a "Top Performing Links" section below the platform breakdown:

```ts
// Top 5 YouTube links by views, scoped to window + employee
<TopPerformingLinks linkIds={...} loading={...} />
// Each row: thumbnail (videoId-based) + url + views/likes/comments pills + "Insights: YouTube" badge
```

Uses `useInsightsSummary(startDate, endDate, employeeId)` — same hook, same RangePills (already wired).

### `apps/internal/src/app/reports/links/page.tsx`

Add a new section "Top YouTube Links" below the existing analytics, sorted by views, with employee attribution. Data from `GET /admin/reports/top-youtube-links?startDate&endDate&limit=20`.

```tsx
<section className="v3-card p-5 space-y-3">
  <div className="flex items-center justify-between">
    <p className="font-semibold text-ink">Top YouTube Links · {windowLabel}</p>
    <span className="text-xs text-ink-4">{topLinks.length} links</span>
  </div>
  {topLinks.length === 0 && unsupportedPlatformsInWindow.length > 0 && (
    <p className="text-xs text-ink-4">
      No YouTube links submitted in this window.
      Insights not yet supported for {unsupportedPlatformsInWindow.join(", ")}.
    </p>
  )}
  <ul>...</ul>
</section>
```

### Shared insight badge component

`apps/internal/src/components/insight-badge.tsx`:

```tsx
import { isPlatformInsightSupported } from "@dashmani/shared";

export function InsightBadge({ platform, metric }: { platform: string; metric?: { views?: number | null; likes?: number | null; comments?: number | null; fetchedAt?: string } | null }) {
  const supported = isPlatformInsightSupported(platform);
  if (!supported) {
    return (
      <span title={`Insights not yet supported for ${platform}`}
            className="inline-flex items-center gap-1 text-[10px] text-[#B0B0B0] cursor-help">
        <Info className="h-2.5 w-2.5" /> Insights soon
      </span>
    );
  }
  if (!metric) return null;
  return (
    <span title={`Last updated ${new Date(metric.fetchedAt!).toLocaleString()}`}
          className="inline-flex items-center gap-1 text-[10px] font-semibold text-rose-700 bg-rose-50 rounded-full px-2 py-0.5">
      <Eye className="h-2.5 w-2.5" /> {formatCompact(metric.views ?? 0)}
      · {formatCompact(metric.likes ?? 0)} ♥
    </span>
  );
}
```

Render this on every link row across all three internal Reports pages and the HR insights panel.

---

## 7. Frontend — HR Portal

### `apps/hr/src/app/report/page.tsx`

Add a panel **after the form** (well after the closing `</form>` tag — do NOT touch anything inside the form), titled "Your YouTube insights":

```tsx
{/* === Insights panel — read-only, below the form ===
     Only renders if the employee has at least one YouTube link in the last 30 days.
     Component does its own fetch + visibility check; if empty, returns null. */}
<MyInsightsPanel />
```

```tsx
function MyInsightsPanel() {
  const { data, isLoading } = useMyLinkInsights({ days: 30 });
  // Hide panel entirely if the employee has no YouTube links in the last 30 days.
  const youtubeLinks = data?.filter((l) => l.platform === "youtube") ?? [];
  if (isLoading) return null;            // wait for load before deciding
  if (youtubeLinks.length === 0) return null;  // no panel at all
  return (
    <section id="my-insights" className="mt-8 bg-white border border-[#E8E0D0] rounded-2xl p-5">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-[#1A1A1A]">Your YouTube insights</h3>
          <p className="text-[11px] text-[#7A7A7A] mt-0.5">
            Insights are currently available for YouTube.
            Insights not yet supported for Instagram and Facebook.
          </p>
        </div>
        <span className="text-[10px] text-[#B0B0B0]">Updates every 6h</span>
      </div>
      <MyLinkInsightsList links={youtubeLinks} />
    </section>
  );
}
```

`useMyLinkInsights` is a small SWR hook on `/hr/reports/my-link-insights?days=30`. Rendered as a list of rows: URL truncated · `InsightBadge` (with last-fetched tooltip).

**Critical:** this panel sits OUTSIDE the form. The Smart Paste/dedupe/validation flow stays untouched. The "Submitted today" panel above the form also stays untouched.

**Visibility rule (locked):** Panel hides entirely (returns `null`) when the employee has zero YouTube links in the last 30 days. No empty state, no "coming soon" banner — the section simply isn't rendered. This keeps the HR `/report` page uncluttered for employees who don't post video content. Once an employee submits a YouTube link, the panel appears on next page load.

### Auth — use shared `apiFetch`

`apiFetch` from `@/lib/api` (already used at the top of `report/page.tsx`) reads `hrAccessToken` correctly. The new `useMyLinkInsights` hook must use the same import — **never a local helper** (CLAUDE.md HR local apiFetch footgun note).

---

## 8. Critical "Don't Break" Inventory

| Behavior | File / Convention | Why it matters |
|----------|-------------------|----------------|
| HR Smart Paste + in-submission dedupe + cross-day dedupe | [report/page.tsx](../apps/hr/src/app/report/page.tsx) | Shipped 2026-05-30, load-bearing. New insights UI sits OUTSIDE the form. |
| Per-row red-border validation + ApiError pipeline | [hr/lib/api.ts](../apps/hr/src/lib/api.ts), report/page.tsx | Three interlocking pieces. The insights panel must not throw, otherwise it could surface in the form's error UI. |
| Delete-and-recreate semantics of `POST /hr/reports` | [daily-report.service.ts](../apps/api/src/services/daily-report.service.ts) | Cron + schema design assume this stays. Re-heal query handles the orphan window. |
| `RangePills` "everything follows the pill" | [reports/_range.tsx](../apps/internal/src/app/reports/_range.tsx) | New engagement stat MUST recompute when window changes. Single SWR key per range. |
| `employeeWhere` filter convention | [analytics.service.ts](../apps/api/src/services/analytics.service.ts) | If we ever compute "avg engagement per employee", use this exact filter. |
| IST date handling | [packages/shared/src/utils/date.ts](../packages/shared/src/utils/date.ts) | Polling-window math uses `istMidnight(todayIST())`. Never `new Date().toISOString().split("T")[0]`. |
| Per-portal auth keys | CLAUDE.md | HR insights hook uses shared `apiFetch` (reads `hrAccessToken`). Admin uses internal `apiFetch` (reads `accessToken`). |
| Public-endpoint UUID stripping | CLAUDE.md | New endpoints are admin/HR-only, but use explicit `select` on any nested User. Document this in JSDoc. |
| `formatStatus()` / `safeString` | shared utils | No new user-facing enum strings introduced. If we ever expose `status: "not_found"` to UI, run it through `formatStatus()`. |
| Lowercase `platform` in queries | [analytics.service.ts](../apps/api/src/services/analytics.service.ts), [admin-reports.routes.ts](../apps/api/src/routes/admin-reports.routes.ts) | Cron must filter with `platform: { equals: slug, mode: "insensitive" }`. Snapshots are written lowercase. |
| `report_links.platform` mixed casing | data state | The cron normalises via `mode: "insensitive"` match. New `link_metrics.platform` is always lowercase on write. |

---

## 9. Step-by-Step Implementation Order

Each step is its own small PR. Verify the "check" before moving on.

### Step 1 — Schema (additive)
- **Files:** [packages/db/prisma/schema.prisma](../packages/db/prisma/schema.prisma) (add `LinkMetric` model + reverse relations on `User` and `ReportLink`)
- **Action:** `npm run db:generate` locally; verify Prisma client compiles.
- **Verify:** `npm run db:push` locally succeeds; `prisma studio` shows the new `link_metrics` table; no other tables touched.

### Step 2 — Shared support helper
- **Files:** new `packages/shared/src/utils/social-insights.ts`, new `packages/shared/src/utils/youtube.ts`, export both from `packages/shared/src/index.ts`.
- **Verify:** `npx tsc --noEmit` clean in `packages/shared`. Vitest covers `extractVideoId` with all 6 URL shapes.

### Step 3 — Provider scaffolding (no API calls yet)
- **Files:** new `apps/api/src/services/social-insights/{types.ts,registry.ts,index.ts,youtube.provider.ts,instagram.provider.ts,facebook.provider.ts}`. IG/FB are stubs (`isSupported: () => false`, `fetchBatch` throws).
- **Verify:** `getProvider("youtube")` returns the YouTube provider; `getSupportedSlugs()` returns `["youtube"]`.

### Step 4 — YouTube provider real impl
- **Files:** flesh out `youtube.provider.ts`. Read `YOUTUBE_API_KEY` from `process.env`. Wire `fetch` with 10s `AbortController` timeout.
- **Verify:** From a one-off `tsx` script, call `provider.fetchBatch([{linkId:"x", url:"https://youtu.be/dQw4w9WgXcQ", videoId:"dQw4w9WgXcQ"}])` and inspect the result. Test deleted video, private video, batch of 50, network failure, 403/quotaExceeded.

### Step 5 — Insights read service
- **Files:** new `apps/api/src/services/social-insights.service.ts` — `getLinkMetricsHistory(linkId)`, `getInsightsSummary({startDate, endDate, employeeId?})`, `getMyLinkInsights(employeeId, days)`, `getTopYouTubeLinks({startDate, endDate, limit})`.
- **Verify:** Vitest for each function with seeded snapshot data.

### Step 6 — API routes
- **Files:** [admin-reports.routes.ts](../apps/api/src/routes/admin-reports.routes.ts) (3 new routes), [hr.routes.ts](../apps/api/src/routes/hr.routes.ts) (1 new route).
- **Verify:** `curl` each endpoint locally with a valid token, confirm envelope shape + 403 for wrong portal token.

### Step 7 — Cron job
- **Files:** new `apps/api/src/cron/social-insights.cron.ts`. Add bootstrap to [apps/api/src/index.ts](../apps/api/src/index.ts) (`setInterval` every 6h, mirror follower-sync pattern).
- **Verify:** Run a one-off script first: `tsx -e 'import("./apps/api/src/cron/social-insights.cron").then(m => m.runSocialInsightsRefresh())'`. Inspect `link_metrics` rows. Then start the API server, watch log on first boot.

### Step 8 — Shared insight badge component
- **Files:** new `apps/internal/src/components/insight-badge.tsx` and `apps/hr/src/components/insight-badge.tsx` (duplicated, per the no-cross-app-imports rule).
- **Verify:** Storybook-style sanity check in dev — supported platform with data shows badge; supported platform without data shows nothing; unsupported platform shows greyed pill with tooltip.

### Step 9 — Internal Reports stat additions
- **Files:** [apps/internal/src/app/reports/page.tsx](../apps/internal/src/app/reports/page.tsx) (+1 stat card), [apps/internal/src/app/reports/[employeeId]/page.tsx](../apps/internal/src/app/reports/[employeeId]/page.tsx) (+1 stat card + Top Performing Links section), [apps/internal/src/app/reports/links/page.tsx](../apps/internal/src/app/reports/links/page.tsx) (+Top YouTube Links section). New SWR hook in `use-reports.ts`.
- **Verify:** Toggle RangePills 24h/7d/30d/Year — engagement stat re-fetches and updates. Switch employee dropdown — engagement scopes to that employee. Set window to a period with only Instagram links — empty-state shows "Insights not yet supported for instagram".

### Step 10 — HR insights panel
- **Files:** [apps/hr/src/app/report/page.tsx](../apps/hr/src/app/report/page.tsx) — add `<MyInsightsPanel>` AFTER the form's closing tag. New `useMyLinkInsights` SWR hook in `apps/hr/src/lib/hooks/use-reports.ts`.
- **Verify:** Smart Paste still works (paste 3 URLs, dedupe still triggers, validation errors still surface on rows). Submit a report, refresh, panel shows the YouTube links with metrics (after a cron run). Other-platform links show in the list with the greyed "Insights soon" badge.

### Step 11 — End-to-end smoke test
- **Verify (manual):**
  1. Submit a YouTube link via HR `/report`.
  2. Trigger cron manually: `npm run dev -w @dashmani/api` and wait for startup, or run the standalone tsx invocation.
  3. Confirm `link_metrics` has a fresh row.
  4. Reload internal `/reports` → engagement stat shows views; switch window; switch employee.
  5. Reload HR `/report` → "Your YouTube insights" shows the link with views/likes/comments.
  6. Resubmit the same report with the same YouTube URL — metric history persists, new `ReportLink.id` is re-linked by the re-heal query on next cron tick.
  7. Delete that link → cron stops polling it but snapshots remain queryable via the denormalised `employeeId`/`reportDate`/`urlNormalized`.

### Step 12 — Deploy
- Merge to `main` → CI auto-deploys.
- SSH to Linode, **diff the prod `link_metrics` table absence vs schema** (will be missing, that's the additive change), then `npm run db:generate && npm run db:push`.
- Add `YOUTUBE_API_KEY` to `/opt/dashmani-platform/apps/api/.env` on prod (runtime-only env var — no rebuild needed, just `pm2 restart api`).
- Watch `pm2 logs api` for `[social-insights] starting at ...` on the next 6h tick.

---

## 10. Future-Platform Notes

### Instagram (Graph API — Business accounts only)
- Requires **per-employee OAuth** flow: employee connects their IG Business account via Facebook Login.
- New table `OAuthConnection { userId, platform, accessToken (encrypted), refreshToken, expiresAt, externalAccountId }`.
- `instagram.provider.ts` `isSupported()` becomes **per-link**, not global: `isSupportedForEmployee(employeeId)` checks the OAuth connection.
- The provider interface needs a second method `isSupportedForLink(link: { employeeId, ... })` once OAuth-gated platforms come online. Update `getSupportedInsightPlatforms()` signature to optionally take an `employeeId`.
- Metric fields available: views (for Reels/Videos), likes, comments, **saves, reach, impressions**. Schema's existing `link_metrics.shares` is reusable, but new fields (`saves`, `reach`, `impressions`) need additive columns — purely additive, `db:push` safe.

### Facebook (Graph API)
- Same per-employee OAuth pattern as Instagram (shared Meta auth).
- Metric fields: reactions (aggregate), comments, shares, post-impressions.

### Schema/UI acceptance
- **Schema:** `link_metrics` already has `views/likes/comments/shares`. New platform-specific fields (saves, reach, impressions) are additive nullable columns. No rework.
- **UI:** Frontend already routes through `isPlatformInsightSupported(platform)`. Once IG/FB providers report `isSupported: true`, badges and stats appear automatically — no per-page code edits needed.
- **One change required:** the `getSupportedInsightPlatforms()` helper grows to take an optional `employeeId` for per-link checking when OAuth-gated platforms ship. The pure-platform check remains valid for the "is this platform supported in principle" UI signal.

---

## 11. Resolved Decisions (locked 2026-05-30)

| # | Decision | Final choice | Rationale |
|---|----------|--------------|-----------|
| 1 | `link_metrics.linkId` FK strategy | **Nullable + SetNull + denormalize + re-heal** | Preserves metric history across `POST /hr/reports` delete-and-recreate resubmits. Re-heal SQL query on every cron tick reconnects orphans. |
| 2 | Polling window cutoff | **60 days** | YouTube videos plateau by 60d for typical creator-output content. Bounds long-term quota usage. |
| 3 | Denormalize `videoId` onto `ReportLink` | **No** | Extractor is microsecond-cheap. Cleaner schema. |
| 4 | Engagement card placement on `/reports` | **5th card on existing strip** | Consistent with existing pattern. Strip becomes 5-wide on lg, 2x3 on md. |
| 5 | "Top performing" sort metric for `/reports/links` panel | **Views descending** | Simplest, most universally understood. Note: this is the *content* sort on the Top YouTube Links panel only — **not the leaderboard**. |
| 6 | ⚠️ **Leaderboard ranking** | **Unchanged — stays "most links submitted"** | User explicitly requested leaderboard NOT be changed. No engagement-based ranking added. The existing leaderboard logic, page, and SWR keys are untouched. |
| 7 | Cron mechanism | **`setInterval` every 6h from API boot** | Matches existing follower-sync pattern. No new dependencies. Timer-relative (not wall-clock). |
| 8 | Empty-state copy | **"Insights not yet supported for [Platform]"** | Honest, factual, dynamic. Lists whichever platforms aren't supported in the current view. |
| 9 | Snapshot retention | **Keep all forever** | Tiny data footprint (~MB/year at current scale). Don't optimize prematurely. |
| 10 | YouTube quota tracking | **None for v1** | 10K units/day handles ~500K polls/day; expected usage <50 units/day. |
| 11 | HR panel visibility | **Hide entirely if no YouTube links in last 30 days** | Keeps the HR `/report` page uncluttered for non-video employees. Component returns `null` when the filtered list is empty. |

---

## Implementation guardrails derived from §11

These are non-negotiable based on the above decisions:

1. **Leaderboard files MUST NOT be modified.** No edits to:
   - [apps/api/src/routes/admin-features.routes.ts](../apps/api/src/routes/admin-features.routes.ts) (leaderboard endpoint)
   - [apps/api/src/services/analytics.service.ts](../apps/api/src/services/analytics.service.ts) leaderboard-related functions
   - [apps/internal/src/app/leaderboard/page.tsx](../apps/internal/src/app/leaderboard/page.tsx)
   - Any HR leaderboard page or hook
   The "Top YouTube Links" panel on `/reports/links` is **not** a leaderboard — it's a separate content-discovery panel.

2. **HR insights panel must be entirely self-hiding.** It must:
   - Render `null` when `youtubeLinks.length === 0` (after fetch resolves)
   - Render `null` while loading (no skeleton, no flash)
   - Never block, error, or visually affect the form above it
   - Failure modes (API down, 500, empty array) all collapse to "render null"

3. **Re-heal query must be idempotent** — running it twice in a row produces the same result. Always check `m.link_id IS NULL` to avoid overwriting valid links.

---

## Critical Files for Implementation

- [packages/db/prisma/schema.prisma](../packages/db/prisma/schema.prisma)
- [apps/api/src/services/daily-report.service.ts](../apps/api/src/services/daily-report.service.ts)
- [apps/api/src/routes/admin-reports.routes.ts](../apps/api/src/routes/admin-reports.routes.ts)
- [apps/api/src/index.ts](../apps/api/src/index.ts)
- [apps/hr/src/app/report/page.tsx](../apps/hr/src/app/report/page.tsx)
- [apps/internal/src/app/reports/page.tsx](../apps/internal/src/app/reports/page.tsx)
- [packages/shared/src/index.ts](../packages/shared/src/index.ts)