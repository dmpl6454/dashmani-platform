# Insights Performance + Snapchat Completeness Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the production performance/crash cluster (leaderboard + reports slow/timeout/crash, Total Engagement showing 0) caused by unbounded `findMany` scans over the 2.15M-row `link_metrics` table, and close the Snapchat reflection gaps (Dashboard Links Activity pill, Top Performers tab, and honest null-views display) — without regressing any previously-fixed behavior.

**Architecture:** The root cause of the crashes is `getInsightsSummary()` and `getTopLinksByPlatform()` in `social-insights.service.ts` doing unbounded `prisma.linkMetric.findMany()` over all `status='ok'` rows in a window (337K+ rows for 30d), hydrating them with a joined `employee` relation into Node heap on a 2GB box, then deduping/slicing in JS — the exact OOM/timeout anti-pattern the project's own incidents warn against (`incident_2026_07_09`). We rewrite both to SQL `DISTINCT ON` (mirroring the *already-fixed* `leaderboard.service.ts` functions), push the aggregation into Postgres, and rely on the tuned covering index (already created on prod this session, see Task 0). Separately, three small Snapchat display gaps are closed additively, and the Snapchat null-views rate is investigated to confirm it's legitimate sentinel data (not a scraper bug) and the UI made honest about it.

**Tech Stack:** Node/Express + Prisma + Postgres (raw SQL via `prisma.$queryRaw`), Next.js (internal portal), Vitest.

---

## Root-cause evidence gathered this session (do NOT re-litigate — this is the verified baseline)

All verified live against production (`dashmani_prod`, 2026-07-16), not assumed:

1. **`link_metrics` has 2,152,714 rows.** The leaderboard `DISTINCT ON` query was a **Parallel Seq Scan + 42MB external-merge disk sort = 12,003ms**. **FIXED in Task 0 (already done this session):** created `link_metrics_emp_url_fetched_ok_idx` (partial+covering) via `CREATE INDEX CONCURRENTLY` → same query now an **Index Only Scan = 1,097ms (~11× faster)**, index confirmed `indisvalid=t`.

2. **Total Engagement shows "0" but data exists:** 760,388 `link_metrics` rows in the last 30 days (by `report_date`), 10.48 billion total views. `getInsightsSummary()` (powering Total Engagement + the reports stat strip) does an **unbounded `findMany`** returning **337,605 rows for 30d** (EXPLAIN: Parallel Seq Scan + 27MB disk sort = 3,935ms at the DB layer), then loads all rows **with a joined `employee` object (~218 bytes/row ≈ 70MB+ hydrated)** into Node heap and dedupes in JS. On the 2GB box under concurrency this OOMs/times out → the request fails → the frontend falls back to `0`/empty. This is the **conditional/deferred "measure then rewrite" task** from the Snapchat PR (memory: `project_snapchat_spotlight_shipped_2026_07_15`) — correctly deferred then because local dev has 0 `link_metrics` rows; now measured at prod scale and confirmed broken.

3. **`getTopLinksByPlatform()` shares the same unbounded-findMany + JS-dedup + `.slice(limit)`-after-load pattern** (line ~220), but is **bounded per-platform** (`where: {platform, status:'ok'}`) so each call is much smaller (Snapchat ~729 rows) — lower OOM risk than `getInsightsSummary` (no platform filter) but still the wrong pattern and worth fixing for consistency + safety as the table grows.

4. **The `/reports` page fires 5 heavy calls on load:** `useInsightsSummary(startDate,endDate)` (the big one) + 4× `useTopLinks` (youtube/instagram/facebook/snapchat). The **"back from leaderboard → never loads / shows 0 / crashed"** symptom is this overload landing on a box already stressed; fixing `getInsightsSummary` removes the dominant cost.

5. **Snapchat data completeness:** of 729 Snapchat `status='ok'` Spotlight rows, **306 have views (42%), 423 are null (58%)**. Live-probed a null-views Spotlight from the Linode IP: `/spotlight/<id>` **301-redirects → `/p/<profileId>/spotlight/<id>` (200)**, whose `__NEXT_DATA__` contains real viewCounts for neighbors AND **`"viewCount":"-1"` for the target story** — the documented Snapchat sentinel meaning "not publicly exposed", which the scraper **correctly maps to null** (`snapchat-scraper.ts` line ~331). So the null views appear to be **legitimate/expected**, NOT a parser bug — but this MUST be confirmed at scale (Task 5) before concluding, because the `/p/<profileId>/spotlight/` URL shape is new and could in principle drift `stories[0]` indexing.

6. **Dashboard "Links Activity" pills** come from `platformBreakdown` (a groupBy count of `report_links.platform`). There ARE **51 Snapchat report_links in the last 30 days** (vs IG 29,397 / FB 16,221 / YT 1,420), so a Snapchat pill *should* render but doesn't — a display gap (top-N or hardcoded platform list). Real, small.

7. **Top Performers** platform tabs (`dashboard/page.tsx` lines 146-148) = `youtube`, `facebook`, `instagram` — **no `snapchat`**. Confirmed real gap. (Top *Links* pills at lines 204-207 DO include snapchat — that part works.)

8. **⚠️ Do NOT regress these previously-fixed things:** (a) the leaderboard `showLikes:false` Snapchat guard that hides the likes column instead of showing a fabricated "0" (`leaderboard/page.tsx` ~line 482); (b) `fmtCompact()` returning `"—"` for `null` (never "0") in both `dashboard/page.tsx` ~404-409 and `use-growth.tsx` ~68-74; (c) the all-time (not 90-day) default in the leaderboard engagement functions; (d) the leaderboard's own `DISTINCT ON` rewrite + 60s cache. Any change here must preserve all four.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `apps/api/src/services/social-insights.service.ts` | `getInsightsSummary` + `getTopLinksByPlatform` (+ 3rd findMany ~line 315) | **Modify** — rewrite unbounded findMany → SQL `DISTINCT ON` |
| `apps/api/tests/social-insights.test.ts` | Regression tests for the rewrite (output-identical) | **Create or Modify** |
| `apps/internal/src/app/dashboard/page.tsx` | Top Performers tabs + Links Activity pills | **Modify** — add Snapchat |
| `apps/api/src/services/social-insights/snapchat-scraper.ts` | (read-only investigation Task 5) | **No change unless Task 5 finds a real gap** |
| `apps/internal/src/app/reports/page.tsx` | Top Snapchat Spotlights null-views copy | **Modify** — honest null note (Task 6) |
| `CLAUDE.md` | Document the fix | **Modify** |
| memory files | Record findings | **Create** |

**⚠️ `db:push` is NOT required** — the tuned index (Task 0) is created manually via `CREATE INDEX CONCURRENTLY` (already done), and the plain form is already declared in `schema.prisma`. No schema field changes.

---

## Task 0: Tuned covering index on `link_metrics` — ALREADY DONE THIS SESSION (verify only)

**Files:** none (prod DB operation, already executed).

This was run live during planning. This task documents it + adds a verification step so the executing engineer confirms it's still present (a later `db:push` or DB restore could theoretically drop a manually-created index).

- [ ] **Step 1: Verify the index exists and is valid on prod**

```bash
ssh linode "sudo -u postgres psql -d dashmani_prod -P pager=off -c \"SELECT i.relname, idx.indisvalid FROM pg_class i JOIN pg_index idx ON i.oid=idx.indexrelid WHERE i.relname='link_metrics_emp_url_fetched_ok_idx';\""
```
Expected: one row, `indisvalid = t`. If MISSING, re-create it:
```bash
ssh linode "sudo -u postgres psql -d dashmani_prod -P pager=off -c \"CREATE INDEX CONCURRENTLY IF NOT EXISTS link_metrics_emp_url_fetched_ok_idx ON link_metrics (employee_id, url_normalized, fetched_at DESC) INCLUDE (views, likes, comments, report_date) WHERE status = 'ok';\""
```

- [ ] **Step 2: Confirm the leaderboard query uses it (Index Only Scan)**

```bash
ssh linode "sudo -u postgres psql -d dashmani_prod -P pager=off -c \"EXPLAIN (ANALYZE) SELECT DISTINCT ON (employee_id, url_normalized) employee_id, url_normalized, views, likes, comments FROM link_metrics WHERE status='ok' ORDER BY employee_id, url_normalized, fetched_at DESC;\"" | grep -E "Index Only Scan|Execution Time"
```
Expected: shows "Index Only Scan using link_metrics_emp_url_fetched_ok_idx" and Execution Time ~1000ms (not ~12000ms).

---

## Task 1: Rewrite `getInsightsSummary` to SQL DISTINCT ON (the crash/Total-Engagement-0 fix)

**Files:**
- Modify: `apps/api/src/services/social-insights.service.ts` (`getInsightsSummary`, lines ~89-188)
- Test: `apps/api/tests/social-insights.test.ts`

**Why:** This is the dominant OOM/timeout. We replace the unbounded `findMany` + JS dedup with a Postgres `DISTINCT ON` that returns only the latest snapshot per `(employee_id, url_normalized)`, using the Task 0 covering index. The aggregation (totals + per-platform) is done over the already-deduped, much smaller result. **Output must be byte-identical** to the current function's shape (`InsightsSummary` interface unchanged).

- [ ] **Step 1: Write a regression test capturing current output shape**

Add to `apps/api/tests/social-insights.test.ts` (create the file if absent; mirror the DB-backed test style in `daily-report.test.ts` — `import "./setup"` for the truncate, seed via `prisma`):

```typescript
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "@dashmani/db";
import { getInsightsSummary } from "../src/services/social-insights.service";
import "./setup";

async function seedUser(name: string) {
  const role = await prisma.role.create({ data: { name: `R-${name}-${Date.now()}` } });
  return prisma.user.create({ data: { name, email: `${name}-${Date.now()}@t.com`, passwordHash: "x", status: "ACTIVE", roles: { create: { roleId: role.id } } } });
}

describe("getInsightsSummary (DISTINCT ON rewrite)", () => {
  it("returns latest-snapshot-per-(employee,url) totals + per-platform, ignoring older snapshots", async () => {
    const u = await seedUser("ins");
    // two snapshots for the SAME (employee,url) — only the LATEST (higher fetchedAt) must count
    await prisma.linkMetric.createMany({ data: [
      { employeeId: u.id, reportDate: new Date("2026-07-10"), url: "https://youtube.com/watch?v=A", urlNormalized: "yt:A", platform: "youtube", status: "ok", views: 100, likes: 10, comments: 1, fetchedAt: new Date("2026-07-10T00:00:00Z") },
      { employeeId: u.id, reportDate: new Date("2026-07-11"), url: "https://youtube.com/watch?v=A", urlNormalized: "yt:A", platform: "youtube", status: "ok", views: 500, likes: 50, comments: 5, fetchedAt: new Date("2026-07-11T00:00:00Z") },
      { employeeId: u.id, reportDate: new Date("2026-07-11"), url: "https://instagram.com/p/B", urlNormalized: "ig:B", platform: "instagram", status: "ok", views: null, likes: 20, comments: 2, fetchedAt: new Date("2026-07-11T00:00:00Z") },
      // a non-ok row must be excluded entirely
      { employeeId: u.id, reportDate: new Date("2026-07-11"), url: "https://youtube.com/watch?v=C", urlNormalized: "yt:C", platform: "youtube", status: "not_found", views: null, likes: null, comments: null, fetchedAt: new Date("2026-07-11T00:00:00Z") },
    ]});
    const s = await getInsightsSummary({ startDate: "2026-07-01", endDate: "2026-07-31" });
    // latest yt:A = 500 views, ig:B = 0 views + 20 likes; yt:C excluded
    expect(s.totalViews).toBe(500);
    expect(s.totalLikes).toBe(70);   // 50 + 20
    expect(s.totalComments).toBe(7); // 5 + 2
    const yt = s.byPlatform.find((p) => p.platform === "youtube")!;
    expect(yt.totalViews).toBe(500);
    expect(yt.linkCount).toBe(1); // only yt:A (yt:C is not_found)
    const ig = s.byPlatform.find((p) => p.platform === "instagram")!;
    expect(ig.linkCount).toBe(1);
    expect(ig.totalLikes).toBe(20);
  });
});
```

- [ ] **Step 2: Run to verify it passes on the CURRENT (unbounded) implementation first**

Run: `npm run test -w @dashmani/api -- social-insights.test.ts -t "DISTINCT ON rewrite"`
Expected: PASS (the current JS-dedup implementation already produces these values — this test locks in the behavior we must preserve). If it FAILS on current code, STOP and reconcile the test with actual current behavior before rewriting — the test must green on old code so we know the rewrite is output-identical.

- [ ] **Step 3: Rewrite the data-fetch half of `getInsightsSummary`**

In `apps/api/src/services/social-insights.service.ts`, REPLACE the `findMany` + JS-dedupe block (from `const snapshots = await prisma.linkMetric.findMany({` through the `for (const s of snapshots) { ... latest.push(s) }` dedupe loop, lines ~105-131) with a SQL `DISTINCT ON` that returns the already-deduped latest rows. Keep everything downstream (the aggregation loop, `topLinks` build, return shape) unchanged — it now iterates `latest` which is already deduped:

```typescript
  // Latest snapshot per (employeeId, urlNormalized), deduped IN POSTGRES via DISTINCT ON
  // (uses the link_metrics_emp_url_fetched_ok_idx covering index). Replaces the old
  // unbounded findMany + JS dedupe that hydrated 300k+ joined rows into Node heap and
  // OOM'd/timed out on the 2GB box (the "Total Engagement: 0" + crash bug, 2026-07-16).
  // ⚠️ Do NOT revert to findMany — an unbounded findMany over link_metrics is a known
  // OOM pattern (incident_2026_07_09). Bind params to avoid injection.
  const startClause = startDate ? Prisma.sql`AND report_date >= ${new Date(startDate)}` : Prisma.empty;
  const endClause = endDate ? Prisma.sql`AND report_date <= ${new Date(endDate)}` : Prisma.empty;
  const empClause = employeeId ? Prisma.sql`AND lm.employee_id = ${employeeId}` : Prisma.empty;
  const rows = await prisma.$queryRaw<Array<{
    linkId: string | null; urlNormalized: string | null; url: string; videoId: string | null;
    platform: string; employeeId: string; fetchedAt: Date;
    views: number | null; likes: number | null; comments: number | null; employeeName: string | null;
  }>>(Prisma.sql`
    SELECT lm.link_id AS "linkId", lm.url_normalized AS "urlNormalized", lm.url, lm.video_id AS "videoId",
           lm.platform, lm.employee_id AS "employeeId", lm.fetched_at AS "fetchedAt",
           lm.views, lm.likes, lm.comments, u.name AS "employeeName"
    FROM (
      SELECT DISTINCT ON (employee_id, url_normalized) *
      FROM link_metrics lm
      WHERE status = 'ok' ${startClause} ${endClause} ${empClause}
      ORDER BY employee_id, url_normalized, fetched_at DESC
    ) lm
    JOIN users u ON u.id = lm.employee_id
  `);
  // `rows` is already deduped-to-latest; downstream code expects `latest` with the same fields.
  const latest = rows.map((r) => ({
    linkId: r.linkId, urlNormalized: r.urlNormalized, url: r.url, videoId: r.videoId,
    platform: r.platform, employeeId: r.employeeId, fetchedAt: r.fetchedAt,
    views: r.views, likes: r.likes, comments: r.comments,
    employee: { id: r.employeeId, name: r.employeeName ?? "" },
  }));
```

Add the `Prisma` import at the top of the file if not present:
```typescript
import { Prisma } from "@prisma/client";
```
(Verify the exact import path matches the other services — grep an existing `$queryRaw` user like `leaderboard.service.ts` for how it imports `Prisma`/builds `Prisma.sql`. If `leaderboard.service.ts` uses `prisma.$queryRawUnsafe` or a different builder, MATCH that pattern for consistency.)

⚠️ **Remove the now-unused `const seen`/`const latest: typeof snapshots = []` declarations** the old dedupe block used, since `latest` is now defined above. Confirm no duplicate `latest` declaration remains (tsc will catch it).

- [ ] **Step 4: Run the regression test — must still pass (output-identical)**

Run: `npm run test -w @dashmani/api -- social-insights.test.ts -t "DISTINCT ON rewrite"`
Expected: PASS with identical assertions. If any value differs, the rewrite changed behavior — fix before proceeding.

- [ ] **Step 5: tsc + commit**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json` → zero errors.
```bash
git add apps/api/src/services/social-insights.service.ts apps/api/tests/social-insights.test.ts
git commit -m "fix(insights): getInsightsSummary uses SQL DISTINCT ON (fixes OOM/Total-Engagement-0 at prod scale)"
```

---

## Task 2: Rewrite `getTopLinksByPlatform` to SQL DISTINCT ON (consistency + safety)

**Files:**
- Modify: `apps/api/src/services/social-insights.service.ts` (`getTopLinksByPlatform`, lines ~204-270)
- Test: `apps/api/tests/social-insights.test.ts`

**Why:** Same unbounded-findMany pattern; bounded per-platform so lower risk, but fix for consistency and to prevent the per-platform result growing unbounded as the table ages. The `LIMIT` can now be pushed into SQL (currently `.slice(limit)` after loading everything). Output shape (`TopLink[]`) unchanged.

- [ ] **Step 1: Write the regression test**

Add to `apps/api/tests/social-insights.test.ts`:

```typescript
import { getTopLinksByPlatform } from "../src/services/social-insights.service";

describe("getTopLinksByPlatform (DISTINCT ON rewrite)", () => {
  it("returns latest-per-(employee,url) for the platform, sorted by score, respecting limit", async () => {
    const u = await seedUser("tl");
    await prisma.linkMetric.createMany({ data: [
      { employeeId: u.id, reportDate: new Date("2026-07-10"), url: "https://youtube.com/watch?v=X", urlNormalized: "yt:X", platform: "youtube", status: "ok", views: 100, likes: 0, comments: 0, fetchedAt: new Date("2026-07-10T00:00:00Z") },
      { employeeId: u.id, reportDate: new Date("2026-07-11"), url: "https://youtube.com/watch?v=X", urlNormalized: "yt:X", platform: "youtube", status: "ok", views: 900, likes: 0, comments: 0, fetchedAt: new Date("2026-07-11T00:00:00Z") },
      { employeeId: u.id, reportDate: new Date("2026-07-11"), url: "https://youtube.com/watch?v=Y", urlNormalized: "yt:Y", platform: "youtube", status: "ok", views: 300, likes: 0, comments: 0, fetchedAt: new Date("2026-07-11T00:00:00Z") },
    ]});
    const links = await getTopLinksByPlatform({ platform: "youtube", startDate: "2026-07-01", endDate: "2026-07-31", limit: 20, sortBy: "views" });
    expect(links).toHaveLength(2);
    expect(links[0].urlNormalized).toBe("yt:X"); // latest views=900 > yt:Y 300
    expect(links[0].views).toBe(900);            // latest snapshot, not 100
    const limited = await getTopLinksByPlatform({ platform: "youtube", startDate: "2026-07-01", endDate: "2026-07-31", limit: 1, sortBy: "views" });
    expect(limited).toHaveLength(1);
    expect(limited[0].urlNormalized).toBe("yt:X");
  });
});
```

- [ ] **Step 2: Run to verify it passes on current code**

Run: `npm run test -w @dashmani/api -- social-insights.test.ts -t "getTopLinksByPlatform"`
Expected: PASS on current implementation (locks in behavior). If FAIL, reconcile before rewriting.

- [ ] **Step 3: Rewrite the fetch/dedupe/sort/slice into SQL**

REPLACE the `findMany` + JS dedupe + sort + slice block (lines ~220-270, from `const snapshots = await prisma.linkMetric.findMany` through the final `.map(...)`) with:

```typescript
  const startClause = startDate ? Prisma.sql`AND report_date >= ${new Date(startDate)}` : Prisma.empty;
  const endClause = endDate ? Prisma.sql`AND report_date <= ${new Date(endDate)}` : Prisma.empty;
  // Score in SQL: views (YT/Snapchat) OR likes+comments (IG/FB). Sort + LIMIT in Postgres,
  // over the DISTINCT ON latest-per-(employee,url) set (covering index). Replaces the old
  // unbounded findMany + JS dedupe/sort/slice-after-load. ⚠️ Do NOT revert to findMany.
  const orderExpr = sortBy === "views"
    ? Prisma.sql`COALESCE(views,0) DESC`
    : Prisma.sql`(COALESCE(likes,0) + COALESCE(comments,0)) DESC`;
  const rows = await prisma.$queryRaw<Array<{
    linkId: string | null; url: string; urlNormalized: string | null; videoId: string | null;
    platform: string; employeeId: string; fetchedAt: Date;
    views: number | null; likes: number | null; comments: number | null; employeeName: string | null;
  }>>(Prisma.sql`
    SELECT lm.link_id AS "linkId", lm.url, lm.url_normalized AS "urlNormalized", lm.video_id AS "videoId",
           lm.platform, lm.employee_id AS "employeeId", lm.fetched_at AS "fetchedAt",
           lm.views, lm.likes, lm.comments, u.name AS "employeeName"
    FROM (
      SELECT DISTINCT ON (employee_id, url_normalized) *
      FROM link_metrics
      WHERE status = 'ok' AND platform = ${platform} ${startClause} ${endClause}
      ORDER BY employee_id, url_normalized, fetched_at DESC
    ) lm
    JOIN users u ON u.id = lm.employee_id
    ORDER BY ${orderExpr}
    LIMIT ${limit}
  `);
  return rows.map((r) => ({
    linkId: r.linkId, url: r.url, urlNormalized: r.urlNormalized, videoId: r.videoId,
    platform, employeeId: r.employeeId, employeeName: r.employeeName ?? "",
    views: r.views, likes: r.likes, comments: r.comments, fetchedAt: r.fetchedAt,
  }));
```

⚠️ Confirm `TopLink`'s field types still match (esp. `employeeName: string` — the old code used `s.employee.name` which is non-null; `?? ""` preserves that). Remove the now-unused `seen`/`latest`/`score` locals.

- [ ] **Step 4: Run the test — output-identical**

Run: `npm run test -w @dashmani/api -- social-insights.test.ts -t "getTopLinksByPlatform"`
Expected: PASS.

- [ ] **Step 5: Check the 3rd findMany (line ~315) — assess, fix only if it's the same unbounded pattern**

Read `apps/api/src/services/social-insights.service.ts` around line 315 (the `getContentEngagement`-style function or whatever owns that `findMany`). If it is ALSO an unbounded `linkMetric.findMany` over a window with no `take`/platform bound feeding a JS dedupe, apply the SAME DISTINCT ON rewrite. If it is already bounded (has a `take`, or filters to a small set like a single report's links), leave it and note why in the commit. Do NOT speculatively rewrite a function that's already safe.

- [ ] **Step 6: tsc + commit**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json` → zero errors.
```bash
git add apps/api/src/services/social-insights.service.ts apps/api/tests/social-insights.test.ts
git commit -m "fix(insights): getTopLinksByPlatform uses SQL DISTINCT ON + SQL LIMIT (no unbounded findMany)"
```

---

## Task 3: Add Snapchat to Top Performers tabs (Dashboard)

**Files:**
- Modify: `apps/internal/src/app/dashboard/page.tsx` (the `perfTabs`/platform list ~line 146, and the per-platform fetch/render logic ~line 158-179)

**Why:** Top Performers has YouTube/Facebook/Instagram tabs but no Snapchat, despite the per-platform leaderboard backend supporting Snapchat (ranked by views). The Top *Links* pills already include snapchat (line 207) — this mirrors that for Top Performers.

- [ ] **Step 1: Read the current Top Performers tab wiring**

Run: `sed -n '140,200p' apps/internal/src/app/dashboard/page.tsx` — identify (a) the tab list array (`youtube/facebook/instagram` at ~146-148), (b) the per-platform board fetch (`perfMetric === "youtube" || ... "facebook" || ... "instagram"` at ~177), (c) the `isViews` logic at ~179 (`perfMetric !== "instagram"` → views).

- [ ] **Step 2: Add snapchat to the tab list**

In the `perfTabs` (or equivalently-named) array (~line 146), add snapchat after instagram:
```typescript
    { key: "youtube", label: "YouTube" },
    { key: "facebook", label: "Facebook" },
    { key: "instagram", label: "Instagram" },
    { key: "snapchat", label: "Snapchat" },
```

- [ ] **Step 3: Include snapchat in the per-platform fetch + views-ranking branches**

At ~line 177, extend the condition so snapchat is treated as a per-platform board:
```typescript
    if (perfMetric === "youtube" || perfMetric === "facebook" || perfMetric === "instagram" || perfMetric === "snapchat") {
```
At ~line 179, snapchat ranks by VIEWS (like YT/FB, unlike IG). Update `isViews` so only instagram is likes+comments:
```typescript
      const isViews = perfMetric !== "instagram"; // YT/FB/Snapchat rank by views; IG by likes+comments
```
(This line likely already reads exactly this — confirm it does; if so, no change needed since `!== "instagram"` already includes snapchat.)

⚠️ Confirm the per-platform board data source (the `useSWR`/hook feeding these tabs) actually returns a Snapchat board. Grep for where the `youtube/facebook/instagram` boards are fetched (likely `/admin/reports/platform-leaderboards` or per-platform `useSWR` keys). If the fetch is keyed to a fixed `["youtube","facebook","instagram"]` list, add `"snapchat"` there too. If the backend `getLeaderboardByPlatform` (or equivalent) already handles any platform string, no backend change is needed — verify by checking `leaderboard.service.ts` for a hardcoded platform allow-list.

- [ ] **Step 4: Verify build + visual**

Run: `npx tsc --noEmit -p apps/internal/tsconfig.json && npm run build -w @dashmani/internal` → pass.
Then (Playwright, once prod deployed OR local dev): open `/dashboard`, click the Snapchat tab under Top Performers, confirm it renders a board (or an honest empty state) without a fabricated "0" and without crashing. Snapchat likes are null → if the Top Performers board shows a likes/engagement column, confirm it shows "—" not "0" for snapchat (reuse the leaderboard's `showLikes` pattern if this board renders likes; since snapchat ranks by views, prefer showing views only).

- [ ] **Step 5: Commit**

```bash
git add apps/internal/src/app/dashboard/page.tsx
git commit -m "feat(dashboard): add Snapchat tab to Top Performers (ranked by views)"
```

---

## Task 4: Show Snapchat in Dashboard "Links Activity" platform pills

**Files:**
- Modify: `apps/internal/src/app/dashboard/page.tsx` (Links Activity pills, ~line 238 `linksPlatformBreakdown` + its render ~line 374-420)

**Why:** 51 Snapchat report_links exist in 30d but the Links Activity strip only shows Instagram/Facebook/YouTube. Honest reporting means Snapchat should appear (even at 51). The pills render from `linksPlatformBreakdown` (`platformBreakdown` from the links-analytics endpoint), so the cause is either a top-3 slice or a hardcoded platform list in the pill renderer.

- [ ] **Step 1: Find why Snapchat is dropped**

Run: `sed -n '374,430p' apps/internal/src/app/dashboard/page.tsx` and locate where `linksPlatformBreakdown` is rendered into pills. Determine the drop cause:
  - If it renders a hardcoded subset (e.g. only `["instagram","facebook","youtube"]`), that's the bug.
  - If it `.slice(0,3)`s, snapchat (smallest) falls off.
  - If it maps `linksPlatformBreakdown` directly, the backend `platformBreakdown` may be excluding snapchat.

- [ ] **Step 2: Confirm the backend returns snapchat in platformBreakdown**

```bash
ssh linode "sudo -u postgres psql -d dashmani_prod -P pager=off -c \"SELECT LOWER(platform), COUNT(*) FROM report_links WHERE created_at > now() - interval '30 days' GROUP BY LOWER(platform);\""
```
Expected: snapchat present (~51). This confirms the data exists; the fix is display-side. (If the backend `platformBreakdown` builder in `admin-reports.routes.ts` ~line 143 hardcodes platforms, fix there — but it uses `Object.entries(platformMap)` which is dynamic, so it should already include snapchat.)

- [ ] **Step 3: Fix the render to include all platforms with >0 links**

Change the pill render to map ALL `linksPlatformBreakdown` entries (not a hardcoded/sliced subset), each with its platform color. Reuse the existing platform-color map (the same one `analytics/content/page.tsx` uses — snapchat = `bg-yellow-400`). Show all platforms present; if space is a concern, show top-N by count but ALWAYS include any platform with links rather than a fixed list. Exact code depends on Step 1's finding — write it to render every `linksPlatformBreakdown` row.

- [ ] **Step 4: Verify build + visual**

`npx tsc --noEmit -p apps/internal/tsconfig.json && npm run build -w @dashmani/internal` → pass. Then confirm (Playwright/local) the Links Activity strip shows a Snapchat pill with its 30d count.

- [ ] **Step 5: Commit**

```bash
git add apps/internal/src/app/dashboard/page.tsx
git commit -m "fix(dashboard): show Snapchat in Links Activity platform breakdown"
```

---

## Task 5: Verify Snapchat null-views is legitimate sentinel data (investigation → decide)

**Files:** none unless the investigation finds a real scraper bug (then modify `apps/api/src/services/social-insights/snapchat-scraper.ts`).

**Why:** 58% of Snapchat `ok` Spotlight rows have null views. One live probe showed the target story's `viewCount:"-1"` sentinel (correctly → null), suggesting legitimate. But the `/spotlight/<id>` → `/p/<profileId>/spotlight/<id>` redirect is a NEW URL shape and could in principle break `stories[0]` indexing. This task CONFIRMS at scale before we either (a) conclude it's expected + improve the UI copy (Task 6), or (b) find a parser bug + fix it. **Do NOT guess — sample real data.**

- [ ] **Step 1: Sample 10 null-views Spotlight URLs and probe them from the Linode IP**

```bash
ssh linode "sudo -u postgres psql -d dashmani_prod -P pager=off -t -c \"SELECT url FROM link_metrics WHERE platform ILIKE 'snap%' AND status='ok' AND views IS NULL AND url LIKE '%/spotlight/%' ORDER BY fetched_at DESC LIMIT 10;\"" > /tmp/snap_null_urls.txt
```
For each URL, fetch it FOLLOWING redirects (the scraper does) and extract `stories[0].metadata.engagementStats.viewCount` exactly as `snapchat-scraper.ts` does. Write a small throwaway script (run via `ssh linode` + a node one-liner, or `scripts/`) that: fetches with the Googlebot UA + `-L`, parses `__NEXT_DATA__`, navigates to `spotlightStories[0].metadata.engagementStats`, and prints `{ url, targetViewCount, isSentinel: viewCount === "-1" }`.

- [ ] **Step 2: Classify the results**

- If **most/all** null-views URLs show `viewCount:"-1"` at `stories[0]` → **legitimate sentinel, NOT a bug.** Snapchat genuinely doesn't expose those counts. Proceed to Task 6 (UI honesty), NO scraper change.
- If **many** show a REAL number at `stories[0]` that the scraper failed to capture → **parser bug** (likely the redirect changed the JSON path). Fix `parseSnapchatSpotlightHtml` to read the correct path under the new `/p/<profileId>/spotlight/` structure, add a unit test with a captured real `__NEXT_DATA__` fixture, and re-run the extraction. Document the exact path change.
- If URLs now **404/redirect to login** → different issue (expired content); note it, these are unrecoverable, treat like Story dead-ends.

- [ ] **Step 3: Record the finding**

Write the classification (with the 10-sample evidence) into the plan's outcome notes / a memory. This determines whether Task 6 is "copy only" or "copy + scraper fix". **If a scraper fix is needed, it is fail-open and must NOT alter the follower-scraper code or the `viewCount:"-1"` → null mapping (that mapping is correct).**

---

## Task 6: Make the Top Snapchat Spotlights panel honest about null views

**Files:**
- Modify: `apps/internal/src/app/reports/page.tsx` (Top Snapchat Spotlights panel, ~lines 591-762)

**Why:** Users see a column of bare "—" for Snapchat views and read it as "broken/incomplete data". If Task 5 confirms these are legitimate sentinels (Snapchat not exposing the count), the UI should say so — a short honest note — rather than leaving an ambiguous dash. (If Task 5 found a scraper bug, fix that first; this task still applies for the genuinely-null remainder.)

- [ ] **Step 1: Confirm the panel's existing note + how it renders views**

Run: `sed -n '591,650p' apps/internal/src/app/reports/page.tsx`. The panel already has a note (~line 645: "Snapchat · views (no likes — not exposed by Spotlight)") and renders `fmtCompact(link.views)` → "—" for null. Confirm this.

- [ ] **Step 2: Extend the note to explain null views (only if Task 5 = legitimate sentinel)**

Update the panel's subtitle/note to clarify that a "—" in Views means Snapchat did not publicly expose a view count for that Spotlight (not a data error). Example copy (adapt to the panel's existing note style):
```tsx
// existing note ~line 645, extend it:
"Snapchat · views where Spotlight exposes them (a dash means Snapchat didn't publish a public view count for that post — not missing data)"
```
Keep it concise; match the honest-disclosure tone used elsewhere (Link Search's "only Spotlights are searchable" note).

- [ ] **Step 3: (Optional, only if it improves clarity) show a count summary**

If desired, add a small line under the panel like "N of M Spotlights have public view counts" so the coverage is transparent. Compute from the rendered rows (`links.filter(l => l.views != null).length` of `links.length`). This is additive; skip if it clutters.

- [ ] **Step 4: Verify build + commit**

`npx tsc --noEmit -p apps/internal/tsconfig.json && npm run build -w @dashmani/internal` → pass.
```bash
git add apps/internal/src/app/reports/page.tsx
git commit -m "fix(reports): honest Snapchat Spotlight views note (dash = Snapchat didn't expose count)"
```

---

## Task 7: Full verification (all apps) + prod deploy + post-deploy live checks

**Files:** none.

- [ ] **Step 1: Full local verification**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json` → zero errors.
Run: `npm run test -w @dashmani/api -- social-insights.test.ts leaderboard-engagement.test.ts` → the new/changed suites green. (⚠️ The full API suite has ~39 PRE-EXISTING failures documented in memory `project_reports_extract_spreadsheet` / this session — account-growth/account/analytics/content/daily-report/task/team, all from local test-DB seed FK gaps, NOT this work. Confirm THESE specific files pass; don't be alarmed by the known-unrelated reds. Verify daily-report/leaderboard aren't newly broken by diffing the failing-file list against the pre-change baseline.)
Run: `npm run build` → all 5 apps pass.

- [ ] **Step 2: PR + merge to main (auto-deploys)**

Create a clean branch off `origin/main`, cherry-pick these commits (do NOT bundle unrelated branch work — check `git log origin/main..HEAD` and cherry-pick only this plan's commits), push, PR, merge. GitHub Actions deploys in ~3 min. Verify `curl https://api.digitalsukoon.com/v1/health` returns success.
⚠️ **This plan touches only `social-insights.service.ts` + `dashboard/page.tsx` + `reports/page.tsx` (+ tests + docs). No `db:push`** (the index is already on prod; no schema field change).

- [ ] **Step 3: Post-deploy live verification (the real proof)**

With an admin token (login `tabish@dashmani.com` / `admin@123` against prod — documented lockout-recovery account), OR in a logged-in browser:
- Load `/reports` — **Total Engagement must now show real numbers** (not 0), and the page must load in a few seconds (not hang/crash). Confirm via the browser or by timing `GET /v1/admin/reports/...` (the insights-summary-backed call) — should return in ~1-2s, not time out.
- Load `/reports/leaderboard` — must load quickly (index + DISTINCT ON), stat cards populated (not "— —").
- Navigate **Leaderboard → back to Link Reports** — must load (the reported crash/0-values symptom must be gone).
- `/dashboard` — Top Performers has a Snapchat tab that renders; Links Activity shows a Snapchat pill; Total Engagement shows real per-platform numbers.
- Confirm the leaderboard Snapchat board still hides likes (shows "—" or no likes column, NOT "0") — the previously-fixed behavior must be intact.

- [ ] **Step 4: Measure the insights endpoint improvement on prod**

```bash
ssh linode "sudo -u postgres psql -d dashmani_prod -P pager=off -c \"EXPLAIN (ANALYZE) SELECT DISTINCT ON (employee_id, url_normalized) employee_id, url_normalized, views, likes, comments FROM link_metrics WHERE status='ok' AND report_date >= now() - interval '30 days' ORDER BY employee_id, url_normalized, fetched_at DESC;\"" | grep -E "Scan|Execution Time"
```
Expected: Index Only Scan (or Index Scan) on `link_metrics_emp_url_fetched_ok_idx`, Execution Time well under the old ~4000ms.

---

## Task 8: Re-enable extraction + confirm DeepSeek runs (user has topped up + turned API costs ON)

**Files:** none (operational — separate from the code fixes above but part of "reflect everywhere as desired").

**Context:** The user re-enabled paid LLM (turned "API costs" / Caption enrichment toggle ON — screenshot shows the toggle green and a $10 daily ceiling). The DeepSeek migration (PR #99) is deployed and was verified this session (code live, key present, cache confirmed at ~95%). Extraction had been OFF via `enrichment.enabled=false` (set 2026-07-13). This task confirms it's now running and safely draining the 24,786-row backlog.

- [ ] **Step 1: Confirm the toggle is ON and ceiling is set**

```bash
# via admin token
curl -s https://api.digitalsukoon.com/v1/admin/enrichment/toggle -H "Authorization: Bearer <TOKEN>"   # {enabled:true}
curl -s https://api.digitalsukoon.com/v1/admin/extraction/spend-ceiling -H "Authorization: Bearer <TOKEN>"  # {ceilingUsd:10, todaySpendUsd:...}
```
Expected: `enabled:true` (the screenshot shows it green — confirm it persisted to the DB). Ceiling $10 (user set it; generous but under the $50 DeepSeek balance).

- [ ] **Step 2: Let the scheduled 6h cron run OR trigger one controlled batch**

The scheduled `entity-extraction.cron` runs every 6h. To verify sooner, the extraction runs on its own now that the toggle is on. Watch for the FIRST DeepSeek rows:
```bash
ssh linode "sudo -u postgres psql -d dashmani_prod -P pager=off -c \"SELECT COUNT(*), ROUND(AVG(input_tokens)) avg_in, ROUND(AVG(output_tokens)) avg_out, ROUND(SUM(cost_usd)::numeric,4) spend, ROUND(AVG(cost_usd)::numeric,6) per_call FROM api_usage WHERE provider='deepseek';\""
```

- [ ] **Step 3: HARD verification gate (the money check)**

Once rows appear, confirm per the DeepSeek plan's Task 12 Step 4:
- `avg_out` small (tens, not hundreds) → non-thinking mode working.
- `per_call` ~$0.00008–$0.0004 → cache hitting. **HARD STOP + alert user if per_call ≈ $0.0029** (cache not hitting — the backlog would cost ~$67-134 instead of ~$5; investigate prefix stability before letting it drain).
- `todaySpendUsd` climbing slowly toward the drain cost, not spiking.

- [ ] **Step 4: Monitor backlog drain**

```bash
ssh linode "sudo -u postgres psql -d dashmani_prod -P pager=off -c \"SELECT COUNT(*) pending FROM link_content WHERE status='ok' AND extracted_at IS NULL;\""
```
Expected: `pending` falls from ~24,786 toward 0 over subsequent cron runs; spend stays well under $10/day and under the $50 balance. Report final drain cost to the user.

---

## Task 9: Update CLAUDE.md + memory

**Files:**
- Modify: `CLAUDE.md`
- Create: memory file(s)

- [ ] **Step 1: CLAUDE.md** — add to the Internal Portal insights/leaderboard section: the 2026-07-16 fix that `getInsightsSummary`/`getTopLinksByPlatform` were rewritten from unbounded findMany to SQL DISTINCT ON (fixing Total-Engagement-0 + reports/leaderboard crashes at prod scale), the tuned `link_metrics_emp_url_fetched_ok_idx` covering index created on prod (12s→1.1s), and ⚠️ never re-introduce an unbounded `findMany` over `link_metrics`. Note Snapchat null-views are legitimate `viewCount:-1` sentinels (per Task 5 finding), and the Dashboard now includes Snapchat in Top Performers + Links Activity.

- [ ] **Step 2: memory** — create `project_insights_perf_snapchat_completeness_2026_07_16.md` capturing: the root causes (unbounded findMany, missing index, display gaps), the fixes, the Snapchat null-views classification from Task 5, and links to `[[project_snapchat_spotlight_shipped_2026_07_15]]`, `[[incident_2026_07_09_hr_report_mobile_and_oom]]`, `[[incident_2026_07_14_reports_leaderboard_slow]]`. Add the one-line pointer to `MEMORY.md`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: insights perf rewrite + Snapchat completeness (2026-07-16)"
```

---

## Self-Review Notes

- **Every reported symptom maps to a task, each root-caused with live evidence (not guessed):** leaderboard slow/crash → Task 0 (index, done) + Task 1 (getInsightsSummary rewrite); reports slow on date-change + back-nav crash/0 → Task 1; Total Engagement 0 → Task 1; Snapchat Top Links incomplete → Task 5 (investigate) + Task 6 (honest UI); Dashboard no Snapchat pill → Task 4; Top Performers no Snapchat → Task 3; re-enable extraction → Task 8.
- **No regression of previously-fixed work** (called out in the evidence section item 8 + guarded in Task 3/6/7 steps): leaderboard `showLikes:false`, `fmtCompact` null→"—", all-time default, leaderboard DISTINCT ON + cache all preserved. Tasks 1/2 are output-identical rewrites verified by tests that must pass on OLD code first.
- **Index already created + measured this session** (12,003ms → 1,097ms, valid) — Task 0 is verify-only.
- **`db:push` NOT required** — no schema field change; index is manual + already declared in schema DSL.
- **Snapchat null-views is likely legitimate** (`viewCount:-1` sentinel, one probe confirmed) but Task 5 verifies at scale BEFORE any scraper change, and forbids touching the follower-scraper or the correct `-1`→null mapping.
- **Money safety** for Task 8 mirrors the DeepSeek plan's hard-stop gate ($0.0029/call = cache broken → stop).
- **Placeholder scan:** all code steps show real code or exact commands; the two "depends on Step-1 finding" spots (Task 3 Step 3 backend allow-list, Task 4 Step 3 render) are framed as "confirm then write" with the exact thing to look for, because the precise line depends on current file state — the engineer has the exact grep/target to resolve it, not a vague "handle it".

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-16-insights-perf-snapchat-completeness.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.
**2. Inline Execution** — execute here with checkpoints.

Which approach?