# Link Search Performance & UX Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Link Search being slow on every keystroke and showing no loading indicator during refetches.

**Architecture:** Two independent fixes — (1) cache the `buildCoverage()` result in memory for 5 minutes on the API server so it doesn't re-run 5 heavy SQL queries on every search request; (2) use SWR's `isValidating` flag instead of `isLoading && !data` on the frontend so the spinner shows during every in-flight request, not just the first.

**Tech Stack:** Node.js / TypeScript (API), React + SWR (frontend), Prisma + raw SQL (DB layer). No new packages required.

---

## Problem Statement (for full context)

### Root Issue: Slowness

Every call to `GET /admin/link-search?q=...` — including every debounced keystroke — runs `buildCoverage()` before doing anything else. `buildCoverage()` fires **5 parallel database queries** regardless of what was searched:

```
File: apps/api/src/services/link-search.service.ts, line 321

export async function searchLinksByEntity(params) {
  const coverage = await buildCoverage();  // ← ALWAYS runs, even for empty q
  ...
}
```

Two of those 5 queries are raw SQL CTEs that regex-scan all of `report_links` (~40k rows) and join to `link_content` (~30k rows):

```sql
-- Runs on EVERY search (searchableByPlatform, lines 132–152):
WITH submitted_keys AS (
  SELECT DISTINCT
    CASE
      WHEN url ~* 'youtube\.com/watch...' THEN 'yt:' || substring(...)
      ...
    END AS k
  FROM report_links  -- full scan (~40k rows)
  WHERE url IS NOT NULL AND is_scheduled = false
)
SELECT lc.platform, count(*)::bigint AS searchable
FROM link_content lc
JOIN submitted_keys sk ON sk.k = lc."canonicalKey"  -- join (~30k rows)
WHERE lc.status = 'ok'
GROUP BY lc.platform
-- IDENTICAL pattern again for pendingMatchedByPlatform (lines 158–178)
```

`buildCoverage()`'s output is a **global aggregate** — it does not vary by search query. It only changes when the enrichment cron runs (at most every hour). Running it on every API request is pure waste.

### Root Issue: Invisible Loading

In `apps/internal/src/app/reports/link-search/page.tsx`, line 146:

```ts
const loadingFresh = isLoading && !data;
```

SWR's `isLoading` is only `true` when there is **no cached data at all** (the very first fetch). Once any result has been received, `data` is truthy and `isLoading && !data` is permanently `false`. Combined with `keepPreviousData: true` (which keeps the old result visible), subsequent searches display stale results with **zero visual indication** that a new query is running.

The correct SWR flag is `isValidating`, which is `true` during **any in-flight request** including revalidations.

---

## File Map

| File | Change |
|------|--------|
| `apps/api/src/services/link-search.service.ts` | Add module-level TTL cache for `buildCoverage()`; expose `invalidateCoverageCache()` |
| `apps/internal/src/lib/hooks/use-link-search.ts` | Return `isValidating` alongside existing exports |
| `apps/internal/src/app/reports/link-search/page.tsx` | Consume `isValidating`; show spinner on every in-flight request |

---

## Task 1: Cache `buildCoverage()` on the API

**Files:**
- Modify: `apps/api/src/services/link-search.service.ts:100–299`

The fix is a module-level object holding the last result and the timestamp it was computed. If the cache is fresh (< 5 minutes old), return it immediately without hitting the database.

- [ ] **Step 1: Add the cache object and helper immediately above `buildCoverage()`**

In `apps/api/src/services/link-search.service.ts`, find the line:

```ts
async function buildCoverage(): Promise<LinkSearchResult["coverage"]> {
```

Insert these lines **directly above** that function (after the `CANDIDATE_TAKE` constant on line 30, before `buildCoverage`):

```ts
// Coverage is a global aggregate — it only changes when the enrichment cron
// runs (at most hourly). Re-computing it on every search burns 5 heavy queries
// per keystroke. Cache it for 5 minutes; expose an invalidator for tests.
const COVERAGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let _coverageCache: { value: LinkSearchResult["coverage"]; builtAt: number } | null = null;

export function invalidateCoverageCache(): void {
  _coverageCache = null;
}
```

- [ ] **Step 2: Wrap the body of `buildCoverage()` with the cache check**

The current function signature is:

```ts
async function buildCoverage(): Promise<LinkSearchResult["coverage"]> {
  // Four cheap grouped queries:
  ...
  const searchableByPlatform = prisma.$queryRaw<...>`...`;
  ...
  return { ... };
}
```

Replace the entire function with:

```ts
async function buildCoverage(): Promise<LinkSearchResult["coverage"]> {
  const now = Date.now();
  if (_coverageCache && now - _coverageCache.builtAt < COVERAGE_TTL_MS) {
    return _coverageCache.value;
  }

  // Four cheap grouped queries:
  //  1. link_content counts by (platform, status) — searchable (ok) vs unsearchable
  //  2. earliest enriched fetched_at per platform — the auto-detected "since" date
  //  3. report_links count by platform — the HONEST denominator (what was submitted)
  //  4. link_content rows with status='ok' AND extractedAt IS NULL — captured but not
  //     yet entity-tagged (pendingExtraction). These are captions we have but haven't
  //     yet run the LLM tagging pass on, so they're NOT findable by name yet.
  //
  // The accuracy fix: a permanently-unsearchable link (FB not_found) must NOT count
  // toward "searchable", and the denominator is "submitted", not "attempted". So a
  // platform with few enriched rows (e.g. FB/IG historical posts beyond the firehose
  // window) shows e.g. "0 searchable of 18,909 submitted" — never "X of Y enriched"
  // where Y silently grows with failed attempts.
  // SEARCHABLE = captions whose canonicalKey matches a SUBMITTED link — the
  // intersection of link_content(status='ok') and report_links. This is the
  // critical correctness fix (2026-06-27): the old numerator counted ALL ok
  // captions, including ones HARVESTED from administered-Page feeds that no
  // employee ever submitted as a link (~12.8k FB, ~8.5k IG). Counting those made
  // "searchable" exceed "submitted" on FB (26k of 22k — impossible on its face)
  // and silently over-counted IG too. "Searchable of submitted" must mean a
  // SUBSET of submitted, so the numerator is bounded by the denominator.
  //
  // OOM-SAFE: this is a COUNT over a join keyed on derived ids, never a row load.
  // We derive each report_links URL's canonicalKey-equivalent id in SQL (the same
  // shapes canonicalKey() produces: yt:<id>, ig:<shortcode>, fb:<numeric>) and
  // intersect with link_content.canonicalKey. Opaque/unparseable URLs derive to
  // NULL and correctly don't match. The per-post search path is unchanged — this
  // only fixes the aggregate COVERAGE banner.
  // The derived submitted-key CTE is reused by both the searchable and the
  // pending-extraction intersections, so define it once as a SQL fragment.
  // (Inlined into each query below — Prisma $queryRaw doesn't share CTEs across calls.)
  const searchableByPlatform = prisma.$queryRaw<Array<{ platform: string; searchable: bigint }>>`
    WITH submitted_keys AS (
      SELECT DISTINCT
        CASE
          WHEN url ~* 'youtube\.com/watch\?v=|youtube\.com/shorts/|youtu\.be/|youtube\.com/embed/'
            THEN 'yt:' || substring(url from '(?:v=|/shorts/|youtu\.be/|/embed/)([A-Za-z0-9_-]{6,})')
          WHEN url ~* 'instagram\.com/(?:[^/]+/)?(?:p|reel|reels|tv)/'
            THEN 'ig:' || substring(url from 'instagram\.com/(?:[^/]+/)?(?:p|reel|reels|tv)/([A-Za-z0-9_-]+)')
          WHEN url ~* 'facebook\.com/reel/[0-9]'
            THEN 'fb:' || substring(url from 'facebook\.com/reel/([0-9]+)')
          ELSE NULL
        END AS k
      FROM report_links
      WHERE url IS NOT NULL AND is_scheduled = false
    )
    SELECT lc.platform AS platform, count(*)::bigint AS searchable
    FROM link_content lc
    JOIN submitted_keys sk ON sk.k = lc."canonicalKey"
    WHERE lc.status = 'ok'
    GROUP BY lc.platform
  `;

  // pendingExtraction, intersected with submitted links the SAME way as searchable —
  // so nameSearchable = searchable - pendingExtraction stays consistent (both count
  // only submitted-matching captions). A harvested-not-submitted untagged caption
  // must NOT count as "pending" against the submitted denominator.
  const pendingMatchedByPlatform = prisma.$queryRaw<Array<{ platform: string; pending: bigint }>>`
    WITH submitted_keys AS (
      SELECT DISTINCT
        CASE
          WHEN url ~* 'youtube\.com/watch\?v=|youtube\.com/shorts/|youtu\.be/|youtube\.com/embed/'
            THEN 'yt:' || substring(url from '(?:v=|/shorts/|youtu\.be/|/embed/)([A-Za-z0-9_-]{6,})')
          WHEN url ~* 'instagram\.com/(?:[^/]+/)?(?:p|reel|reels|tv)/'
            THEN 'ig:' || substring(url from 'instagram\.com/(?:[^/]+/)?(?:p|reel|reels|tv)/([A-Za-z0-9_-]+)')
          WHEN url ~* 'facebook\.com/reel/[0-9]'
            THEN 'fb:' || substring(url from 'facebook\.com/reel/([0-9]+)')
          ELSE NULL
        END AS k
      FROM report_links
      WHERE url IS NOT NULL AND is_scheduled = false
    )
    SELECT lc.platform AS platform, count(*)::bigint AS pending
    FROM link_content lc
    JOIN submitted_keys sk ON sk.k = lc."canonicalKey"
    WHERE lc.status = 'ok' AND lc.extracted_at IS NULL
    GROUP BY lc.platform
  `;

  const [grouped, sinceByPlatform, submittedByPlatform, pendingMatched, searchableMatched] = await Promise.all([
    prisma.linkContent.groupBy({
      by: ["platform", "status"],
      _count: { _all: true },
    }),
    // "Capturing since" = when we FIRST captured a caption for this platform. Use
    // createdAt (set once at insert), NOT fetchedAt — upsertLinkContent bumps fetchedAt
    // on every re-harvest, so min(fetchedAt) drifts FORWARD as old anchor rows age out
    // (F9). createdAt is immutable → a true, stable start date.
    prisma.linkContent.groupBy({
      by: ["platform"],
      where: { status: "ok" },
      _min: { createdAt: true },
    }),
    // Per-platform SUBMITTED denominator, bucketed by URL HOST (F8) — the numerator
    // (searchable) buckets by link_content.platform which is derived from the URL's
    // canonicalKey, so the denominator must match. The old groupBy on the DIRTY
    // report_links.platform column mis-split IG/FB by ~2,200 (the aggregate was right,
    // only the split misled). ELSE keeps the platform column so no row is dropped — the
    // total is identical, only the bucketing is corrected.
    prisma.$queryRaw<Array<{ platform: string; cnt: bigint }>>`
      SELECT CASE
        WHEN url ~* 'youtube\.com|youtu\.be' THEN 'youtube'
        WHEN url ~* 'instagram\.com' THEN 'instagram'
        WHEN url ~* 'facebook\.com|fb\.watch|fb\.me' THEN 'facebook'
        ELSE lower(coalesce(platform, 'other'))
      END AS platform, count(*)::bigint AS cnt
      FROM report_links
      WHERE url IS NOT NULL AND is_scheduled = false
      GROUP BY 1
    `,
    pendingMatchedByPlatform,
    searchableByPlatform,
  ]);

  const ensure = (map: Record<string, CoverageBucket>, p: string): CoverageBucket => {
    if (!map[p]) map[p] = { enriched: 0, total: 0, searchable: 0, pendingExtraction: 0, nameSearchable: 0, unsearchable: 0, submitted: 0 };
    return map[p];
  };

  let searchable = 0;
  let unsearchable = 0;
  const byPlatform: Record<string, CoverageBucket> = {};

  // SEARCHABLE — captions matching a submitted link (the intersection query). This
  // is a SUBSET of submitted by construction, so it can never exceed the denominator.
  for (const s of searchableMatched) {
    const p = (s.platform || "other").toLowerCase();
    const n = Number(s.searchable);
    ensure(byPlatform, p).searchable += n;
    byPlatform[p].enriched += n; // legacy alias (== searchable)
    searchable += n;
  }

  // UNSEARCHABLE — captions we TRIED but couldn't use (not_found/error/private/etc).
  // Counted from link_content non-ok rows. (We don't intersect these with submitted
  // links — they're a "we attempted N and they failed" signal, kept for the legacy
  // `total`/`notYetEnriched` fields; the headline now leads with searchable/submitted.)
  for (const g of grouped) {
    const n = g._count._all;
    const p = (g.platform || "other").toLowerCase();
    const b = ensure(byPlatform, p);
    if (g.status === "ok") {
      b.total += n; // attempted includes ok (legacy)
    } else {
      b.total += n;
      b.unsearchable += n;
      unsearchable += n;
    }
  }

  // report_links submitted-per-platform (honest denominator), bucketed by URL host to
  // match the numerator's source (F8) — no longer the dirty platform column.
  for (const s of submittedByPlatform) {
    const p = (s.platform || "other").toLowerCase();
    ensure(byPlatform, p).submitted += Number(s.cnt);
  }

  // Auto-detected per-platform coverage date (earliest enriched createdAt — immutable).
  for (const s of sinceByPlatform) {
    const p = (s.platform || "other").toLowerCase();
    const min = s._min.createdAt;
    if (byPlatform[p] && min) byPlatform[p].since = min.toISOString();
  }

  // Pending extraction: status='ok' AND extractedAt IS NULL, INTERSECTED with
  // submitted links (same as searchable) — captured but not yet entity-tagged, so
  // not findable BY NAME yet. Intersecting keeps nameSearchable = searchable -
  // pendingExtraction consistent (both over the submitted-matching universe).
  let pendingExtraction = 0;
  for (const g of pendingMatched) {
    const p = (g.platform || "other").toLowerCase();
    const n = Number(g.pending);
    ensure(byPlatform, p).pendingExtraction += n;
    pendingExtraction += n;
  }

  // Per-platform nameSearchable = searchable - pendingExtraction (clamped at 0).
  for (const b of Object.values(byPlatform)) {
    b.nameSearchable = Math.max(0, b.searchable - b.pendingExtraction);
  }

  const attemptedTotal = searchable + unsearchable;
  const submitted = Object.values(byPlatform).reduce((acc, b) => acc + b.submitted, 0);
  const nameSearchable = Math.max(0, searchable - pendingExtraction);

  const result: LinkSearchResult["coverage"] = {
    // legacy pair (enriched = searchable; total = attempted)
    enriched: searchable,
    notYetEnriched: attemptedTotal - searchable,
    total: attemptedTotal,
    // honest fields
    searchable,
    pendingExtraction,
    nameSearchable,
    unsearchable,
    submitted,
    byPlatform,
  };

  _coverageCache = { value: result, builtAt: Date.now() };
  return result;
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/tabish/Desktop/dashmani-platform
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: no errors.

- [ ] **Step 4: Run the API tests**

```bash
npm run test -w @dashmani/api 2>&1 | tail -20
```

Expected: same pass/fail ratio as before (pre-existing failures are unrelated to this change — see the note in CLAUDE.md about ~36 known pre-existing test failures).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/link-search.service.ts
git commit -m "perf(link-search): cache buildCoverage() for 5 min — skip 5 heavy queries per keystroke"
```

---

## Task 2: Fix the invisible loading indicator on the frontend

**Files:**
- Modify: `apps/internal/src/lib/hooks/use-link-search.ts:26–31`
- Modify: `apps/internal/src/app/reports/link-search/page.tsx:77` and `146`

SWR returns two flags:
- `isLoading` — `true` only when `data` is undefined (first ever fetch for this key)
- `isValidating` — `true` during **any** in-flight request, including refetches with `keepPreviousData`

The bug is using `isLoading && !data` as the loading condition. After the first fetch resolves, `data` is always truthy (SWR keeps the previous value), so this condition is permanently `false` for all subsequent searches.

- [ ] **Step 1: Expose `isValidating` from the hook**

Open `apps/internal/src/lib/hooks/use-link-search.ts`.

Find:

```ts
  return useSWR<LinkSearchData>(
    `/admin/link-search${query}`,
    (url) => apiFetch(url).then((r: any) => r.data ?? r),
    { revalidateOnFocus: false, dedupingInterval: 30_000, keepPreviousData: true },
  );
```

The `useSWR` return value already includes `isValidating` — we just need to pass it through. The full hook currently returns the raw SWR object, so `isValidating` is already available to callers who destructure it. **No change needed to the hook file** — the caller can destructure `isValidating` directly from `useLinkSearch()`.

Verify by reading the SWR return type: `{ data, isLoading, isValidating, mutate, error, ... }`. All fields are already exposed by the current `return useSWR<...>(...)`.

- [ ] **Step 2: Consume `isValidating` in the page**

Open `apps/internal/src/app/reports/link-search/page.tsx`.

Find line 77:

```ts
  const { data, isLoading, mutate: mutateLinkSearch } = useLinkSearch(submitted);
```

Replace with:

```ts
  const { data, isLoading, isValidating, mutate: mutateLinkSearch } = useLinkSearch(submitted);
```

- [ ] **Step 3: Fix the loading condition**

Find line 146:

```ts
  const loadingFresh = isLoading && !data;
```

Replace with:

```ts
  // isValidating = true on EVERY in-flight request (including refetches with
  // keepPreviousData). isLoading is only true before the first result arrives.
  // We want a spinner any time a search is running, so use isValidating.
  const loadingFresh = isValidating;
```

- [ ] **Step 4: Verify the results section still guards correctly**

The `loadingFresh` flag is used in four conditional renders below it:

```tsx
{loadingFresh && (          // show spinner
{!loadingFresh && disambiguation.length > 0 && (  // show disambiguation
{!loadingFresh && disambiguation.length === 0 && entity && (  // show results
{!loadingFresh && submitted && !entity && disambiguation.length === 0 && data && (  // show no-results
```

With `loadingFresh = isValidating`, while a search is in flight:
- The spinner shows.
- The disambiguation / results / no-results panels are hidden.
- The **coverage banner** (above `loadingFresh` in the render tree) remains visible — it's not gated on `loadingFresh`, which is correct: coverage is global and should always show.

This is the correct behavior. No further changes needed to the conditionals.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit -p apps/internal/tsconfig.json
```

Expected: no errors. (`isValidating` is part of the SWR return type and is already recognized by TypeScript.)

- [ ] **Step 6: Build the internal app**

```bash
npm run build -w @dashmani/internal 2>&1 | tail -20
```

Expected: `✓ Compiled successfully` with no new errors.

- [ ] **Step 7: Commit**

```bash
git add apps/internal/src/app/reports/link-search/page.tsx
git commit -m "fix(link-search): show spinner during every search, not just the first (isValidating)"
```

---

## Task 3: Manual verification

There is no automated test for the loading indicator (it requires a browser) or for query latency (it requires a real DB). These must be verified by hand.

- [ ] **Step 1: Start the dev servers**

```bash
npm run dev
```

Wait for all five servers to be ready (API on 4000, Internal on 3000).

- [ ] **Step 2: Verify the spinner shows on every search**

1. Open `http://localhost:3000` and log in.
2. Navigate to **Reports → Link Search**.
3. Type a name (e.g. "Salman") into the search box.
4. Watch the UI: a "Searching…" card should appear within 350ms (the debounce delay) and remain until the result loads.
5. **With the first result showing**, type a different name (e.g. "Kriti").
6. The **old results should disappear and the spinner should show** while the new search is in flight. This is the previously-broken case.

- [ ] **Step 3: Verify coverage banner always shows**

The coverage banner (showing "X searchable of Y submitted") should remain visible **at all times** — during searches, between searches, and on page load. It should never disappear while a search is running.

- [ ] **Step 4: Verify repeated searches are faster**

1. Search for "Salman Khan" — note how long it takes.
2. Clear the search box, wait 2 seconds, search "Salman Khan" again.
3. The second result should return noticeably faster (coverage is served from cache; only the entity + post queries hit the DB).

> The cache TTL is 5 minutes, so if you're testing within 5 minutes of the first search, the second should be faster. After 5 minutes, it rebuilds the cache.

- [ ] **Step 5: Commit nothing** — this task is verification only.

---

## Self-Review

**Spec coverage:**
- [x] `buildCoverage()` cached for 5 minutes — Task 1
- [x] Loading indicator shown on every in-flight request — Task 2
- [x] Manual verification checklist — Task 3

**Placeholder scan:** None found. All code blocks are complete.

**Type consistency:**
- `invalidateCoverageCache()` is exported but not called anywhere in this plan (it's for future test use). No callers reference it, so no naming consistency risk.
- `isValidating` is a native SWR field — no type definition needed.
- `_coverageCache` shape `{ value, builtAt }` is used consistently in one function.

**No `db:push` required** — no schema changes.
**No new packages required** — no `package.json` changes.
