# CEO Dashboard v2 — Polish, Accuracy Fix & New Glance Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Account Growth whitespace, refine Top Performers (drop "Reports", add per-platform selection), correct a verified Top Movers data-accuracy bug (absurd `+2,963,850%` correction-artifacts leaking into the movers board), add two new CEO-relevant glance cards (Total Engagement per platform; Team leaderboard + non-submitters), and fix a verified iOS-Safari horizontal-overflow bug on the **HR** `/report` page that persists in "Desktop Site" mode — all using data the backend already computes, with one tiny surgical backend change and zero new portal load.

> **Note on Task 9 (HR /report Safari fix):** this is an INDEPENDENT bug in a DIFFERENT app (`apps/hr`, not `apps/internal`) — it shares nothing with the dashboard tasks and can be implemented/PR'd separately if desired. It's included here because it was discovered during the same review cycle. Its root cause is verified in real WebKit (see Task 9).

**Architecture:** Almost entirely frontend, in `apps/internal/src/app/dashboard/page.tsx` (+ one small new hook + one existing shared component reuse). The single backend change is **widening one existing predicate** (`isCorrectionArtifact`) in `account-growth.service.ts` — no new query, no new endpoint, no schema change, no `db:push`. Every new card reuses a hook/endpoint that already exists on `main`.

**Tech Stack:** Next.js 14 App Router (client component), SWR, Tailwind (semantic tokens `text-ink`/`bg-indigo`/`bg-sage`/`bg-terra`/`v3-card`), lucide-react, recharts (already imported). No new dependencies.

---

## ⚠️ CRITICAL PRE-FLIGHT — READ BEFORE ANY WORK

**The screenshot that prompted this work is the CURRENTLY-DEPLOYED dashboard on `main` (commit `6800dda`, PR #90 "filter pills on CEO glance cards", already merged and live on prod).** This plan builds ON TOP of that — do NOT reintroduce the pre-pills version. Branch off the current `origin/main`.

**Verify before starting:**
```bash
cd /Users/tabish/Desktop/dashmani-platform
git fetch origin main
git log origin/main --oneline -1   # expect 6800dda or later
git show origin/main:apps/internal/src/app/dashboard/page.tsx | grep -c "topMoversByPlatform\|PERF_METRICS\|TOP_LINK_PLATFORMS"   # expect ≥3 (the pills ARE on main)
```

**Non-negotiable guardrails (the user's explicit priority: "no crashing issues or more load on our portals, no previous errors must resurface"):**
- **Prod is a 1-vCPU / 2 GB box with a documented history of Prisma connection-pool exhaustion crashes (P2024, incident 2026-07-08).** Do NOT add any new DB query that runs on page load. The ONE backend change in this plan (Task 3) adds ZERO queries — it only widens an in-memory filter predicate over data already fetched.
- **Account Growth's fill uses client-side arithmetic over `accounts[]` already in the payload** — NOT a new follower-time-series query (which would touch the large `account_growth_snapshots` table and risk load). This was a deliberate decision after finding the per-account snapshots are stride-sampled on misaligned dates (summing them client-side would be jagged/wrong).
- **No new endpoints, no schema change, no `db:push`.** All five cards' data already exists.
- **Preserve every existing loading/empty/error guard.** A card whose data is empty must show its existing empty state, never crash.
- **Verification per CLAUDE.md:** `npx tsc --noEmit -p apps/internal/tsconfig.json` + full `npm run build` + a live browser click-through (Task 8). The API also has a Vitest suite — the Task 3 backend change MUST get a regression test and `npm run test -w @dashmani/api` must pass.

---

## Empirical accuracy findings (verified against LIVE prod DB — these drive Task 3)

Queried `dashmani_prod` directly. The Top Movers board currently shows correction-artifacts as if they were real growth:

| Account | Platform | 7-day snapshot series | Shown as | Reality |
|---|---|---|---|---|
| **"89"** | Facebook | `2 → 59,287 → 59,282 → 59,279` | **+59.3K (+2,963,850%)** | Baseline of `2` is a bad first sync; real value is ~59K. Garbage %. |
| **Total Filmi** | YouTube | `10,900 → 10,900 → 46,300 → 10,900 → … → 46,300` | **+35.4K (+324.8%)** | Follower resolver oscillating between a stale (10,900) and real (46,300) value. Not organic. |
| Paparazzi | Facebook | ~15,059,985 → 15,213,897 | +153.9K (+1%) | **Legitimate** — real weekly growth on a 15M base. Keep. |
| Paparazzii | Facebook | ~15,060,068 → 15,213,256 | +153.2K (+1%) | Near-duplicate of Paparazzi (distinct profile URL, so existing URL-dedup misses it). |

**Root cause:** the existing `isCorrectionArtifact` predicate (`account-growth.service.ts:336`) is **negative-only** (`deltaPct <= -90`). Its code comment explicitly says positive swings are deliberately kept. But the two live artifacts above are BOTH huge *positive* percentages from an unreliable baseline.

**Verified-safe fix threshold:** A `deltaPct > 200` (i.e. `latest > 3× first`) guard over the 7-day window catches **exactly** "89" (+2,963,850%) and "Total Filmi" (+324.8%) and **NOTHING else** — confirmed by querying all accounts: no legitimate account grew >3× in a week. (A genuinely viral small account is theoretically possible, but at a glance-card level suppressing a >200%/week swing as "likely a data correction" is correct; the full `/accounts/growth` page still shows everything.)

**Other findings (no fix needed):** Top Performers link counts are accurate (Anish's ~5,400 links are all distinct URLs, zero dupe inflation). Account Growth total (279.3M) + live/stale/manual split are trustworthy.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `apps/api/src/services/account-growth.service.ts` | Growth overview service; owns `isCorrectionArtifact`. | **Modify** — widen ONE predicate (Task 3). ~3 lines. No new query. |
| `apps/api/tests/account-growth.*.test.ts` (or nearest existing growth test) | Regression coverage for the artifact filter. | **Modify/Create** — add a test that a tiny-baseline positive spike is suppressed (Task 3). |
| `apps/internal/src/lib/hooks/use-reports.ts` | SWR hooks for reports endpoints. | **Modify** — add `usePlatformLeaderboards` hook (Task 2). ~12 lines. |
| `apps/internal/src/app/dashboard/page.tsx` | The CEO dashboard. | **Modify** — Account Growth fill (Task 1), Top Performers pills (Task 2), two new cards (Tasks 4 & 5), display cap in delta rendering (Task 3b). ~80% of the work. |
| `apps/internal/src/lib/hooks/use-growth.tsx` | Growth hooks + `DeltaBadge`/`fmtCompact`. | **Modify** — add a `%` display cap to `DeltaBadge` (Task 3b). ~2 lines. |

**Why no new component file:** all five cards already share `Pill`/`PillGroup` from `./_pills` (created in the prior plan). The new cards are plain `v3-card` blocks in `page.tsx`, matching the existing four. No new abstraction is warranted.

---

## Verified backend capabilities (reference — only Task 3 changes anything server-side)

| Card / need | Existing endpoint / hook | Shape (verified on `main`) |
|---|---|---|
| Top Performers per-platform | `GET /admin/reports/platform-leaderboards` (leaderboard page inlines `useSWR`; NO hook exists yet → Task 2 adds one) | `Record<"youtube"\|"facebook"\|"instagram", Array<{rank, employee:{id,name,email,profileImageUrl}, views, likes, comments, engagedLinkCount, rankMetric}>>`. YT/FB ranked by views, IG by likes+comments. |
| Total Engagement per platform | `useInsightsSummary(start,end)` → `GET /admin/reports/insights-summary` (**hook already exists**, `use-reports.ts`) | `{ totalViews, totalLikes, totalComments, supportedPlatforms, topLinks[], byPlatform: {platform, totalViews, totalLikes, totalComments, linkCount, supported}[] }` |
| Team leaderboard + non-submitters | `useLinksAnalytics(start,end)` → `GET /admin/reports/links-analytics` (**already fetched twice on the page**) | `.teamRanks: {teamId, teamName, memberCount, totalLinks, avgLinksPerMember}[]`, `.nonSubmitters: {employeeId, name}[]` |
| Account Growth platform split | `useGrowthOverview(days)` (**already fetched**) — `g.accounts[]` each carry `{platform, latest}` | Sum `latest` by `platform` client-side. Pure arithmetic, zero new load. |

---

## Task 0: Branch off current main (MANDATORY FIRST)

**Files:** none (git only)

- [ ] **Step 1: Fetch and branch from the current main (which has the merged pills)**

```bash
cd /Users/tabish/Desktop/dashmani-platform
git fetch origin main
git checkout -b feat/dashboard-v2-polish origin/main
```

> If working in an isolated worktree per the user's usual preference, create it off `origin/main`. A fresh worktree needs `npm install`, the gitignored `.env` files copied from the main checkout (`.env`, `apps/api/.env`, `packages/db/.env`, `apps/*/.env.local`), and `npm run db:generate` before the API dev server will start (Prisma client isn't generated in a fresh worktree).

- [ ] **Step 2: Verify the pills are present (confirms correct base)**

```bash
grep -c "topMoversByPlatform" apps/internal/src/app/dashboard/page.tsx   # expect ≥1
grep -c "isCorrectionArtifact" apps/api/src/services/account-growth.service.ts  # expect ≥5 (defined once, used 5×)
```
Expected: both ≥1. If `0`, you branched off the wrong base — STOP.

- [ ] **Step 3: Clean baseline**

```bash
npx tsc --noEmit -p apps/internal/tsconfig.json   # expect: no errors
```

---

## Task 1: Account Growth — replace whitespace with platform follower mini-bars

**Files:**
- Modify: `apps/internal/src/app/dashboard/page.tsx`

**Problem:** The Account Growth card is `lg:col-span-2` next to the taller Top Movers `lg:col-span-1`. CSS grid's default `align-items: stretch` forces it to match Top Movers' height, but its body is only 3 short lines, so "View all" floats near the top with dead vertical space below. **Fix:** fill the body with an accurate per-platform follower-breakdown bar list (summed client-side from `g.accounts[]`), and let the card's natural `space-y-4` flow push "View all" to the bottom.

- [ ] **Step 1: Derive the platform breakdown from already-fetched data**

Find the growth-derivation block (after `const growthManual: number | undefined = g?.manualCount;`, near line 112). Add immediately after it:

```tsx
  // Per-platform follower split — summed client-side from accounts already in the payload
  // (each carries { platform, latest }). Pure arithmetic, no new fetch/query. Sorted desc.
  // `latest` is the account's current follower count; null-guarded to 0.
  const growthAccounts: { platform: string; latest: number | null }[] = g?.accounts ?? [];
  const growthByPlatform = (() => {
    const map = new Map<string, number>();
    for (const a of growthAccounts) {
      map.set(a.platform, (map.get(a.platform) ?? 0) + (a.latest ?? 0));
    }
    return [...map.entries()]
      .map(([platform, followers]) => ({ platform, followers }))
      .sort((x, y) => y.followers - x.followers);
  })();
  const growthByPlatformMax = growthByPlatform[0]?.followers ?? 0;
```

- [ ] **Step 2: Render the mini-bars inside the card body**

Find the Account Growth card's populated branch (the `) : (` after the `growthAccountCount === 0` empty state, near line 562-577). Replace the inner `<div className="space-y-3">…</div>` block with a version that adds the bars below the existing headline:

```tsx
            <div className="space-y-3">
              <div className="flex items-end gap-3 flex-wrap">
                <p className="font-num text-3xl font-semibold text-ink leading-none">
                  {fmtCompact(g?.totalFollowers)}
                </p>
                <DeltaBadge delta={g?.totalDelta} />
              </div>
              <p className="text-xs text-ink-4">{growthAccountCount} account{growthAccountCount !== 1 ? "s" : ""} tracked</p>
              {(growthLive !== undefined || growthStale !== undefined || growthManual !== undefined) && (
                <p className="text-[11px] text-ink-4">
                  {growthLive ?? 0} live · {growthStale ?? 0} stale · {growthManual ?? 0} manual
                </p>
              )}

              {/* Follower split by platform — fills the card, accurate (current-count sum). */}
              {growthByPlatform.length > 0 && growthByPlatformMax > 0 && (
                <div className="pt-1 space-y-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-4">Followers by platform</p>
                  {growthByPlatform.map((row) => (
                    <div key={row.platform} className="flex items-center gap-3">
                      <span className="text-xs text-ink-3 capitalize w-20 shrink-0 truncate" title={row.platform}>
                        {row.platform}
                      </span>
                      <div className="flex-1 h-2 rounded-full bg-ink/5 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-indigo/70 transition-all duration-500"
                          style={{ width: `${Math.max(2, Math.round((row.followers / growthByPlatformMax) * 100))}%` }}
                        />
                      </div>
                      <span className="font-num text-xs font-semibold text-ink w-14 text-right shrink-0">
                        {fmtCompact(row.followers)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
```

> `Math.max(2, …)` guarantees even tiny platforms show a sliver of bar. The `growthByPlatformMax > 0` guard prevents a divide-by-zero when all accounts have 0 followers.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p apps/internal/tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/internal/src/app/dashboard/page.tsx
git commit -m "feat(dashboard): fill Account Growth card with per-platform follower bars"
```

---

## Task 2: Top Performers — drop "Reports", add per-platform selection

**Files:**
- Modify: `apps/internal/src/lib/hooks/use-reports.ts`
- Modify: `apps/internal/src/app/dashboard/page.tsx`

The user wants: remove the "Reports" pill; keep Links + Engagement; **add per-platform pills** (YouTube / Facebook / Instagram) that rank employees the same fair way the `/reports/leaderboard` page does (YT/FB by views, IG by likes+comments), via `getPlatformLeaderboards`.

- [ ] **Step 1: Add a `usePlatformLeaderboards` hook**

In `apps/internal/src/lib/hooks/use-reports.ts`, add after the existing `useInsightsSummary` hook (matching the file's established hook style):

```tsx
// Fair per-platform leaderboards (YouTube/Facebook by views, Instagram by likes+comments).
// Backend: GET /admin/reports/platform-leaderboards → getPlatformLeaderboards().
// Returns Record<platformKey, Array<{rank, employee:{id,name,...}, views, likes, comments, rankMetric}>>.
export function usePlatformLeaderboards(startDate?: string, endDate?: string) {
  const params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  const query = params.toString() ? `?${params.toString()}` : "";
  return useSWR(`/admin/reports/platform-leaderboards${query}`, (url) => apiFetch(url), {
    revalidateOnFocus: false,
    dedupingInterval: 300_000,
  });
}
```

- [ ] **Step 2: Import the new hook in the dashboard**

In `apps/internal/src/app/dashboard/page.tsx`, update the import on line 8:

```tsx
import { useLinksAnalytics, useTopLinks, usePlatformLeaderboards } from "@/lib/hooks/use-reports";
```

- [ ] **Step 3: Replace `PERF_METRICS` + the `topPerformers` derivation**

Find the Top Performers data block (`PERF_METRICS` through the closing `})();` of the `topPerformers` IIFE, lines 121-171). Replace the whole block with:

```tsx
  // Top Performers metric pill — independent, non-persisted. Links & Engagement come from
  // the leaderboard/analytics payloads; the three platform tabs rank the SAME fair way as
  // /reports/leaderboard (YouTube/Facebook by views, Instagram by likes+comments).
  const PERF_METRICS = [
    { key: "links", label: "Links" },
    { key: "engagement", label: "Engagement" },
    { key: "youtube", label: "YouTube" },
    { key: "facebook", label: "Facebook" },
    { key: "instagram", label: "Instagram" },
  ];
  const [perfMetric, setPerfMetric] = useState("links");
  const { data: leaderboardData } = useSWR(
    `/admin/reports/leaderboard?startDate=${perfStart}&endDate=${perfEnd}`,
    (url: string) => apiFetch<any>(url),
    { revalidateOnFocus: false, dedupingInterval: 300_000 }
  );
  const leaderboardRows: any[] = (leaderboardData as any)?.data ?? [];

  // Per-platform boards (fetched once, cached 5 min). Keyed youtube/facebook/instagram.
  const { data: platformLbData } = usePlatformLeaderboards(perfStart, perfEnd);
  const platformBoards: Record<string, any[]> = (platformLbData as any)?.data ?? {};

  // Build the top-3 list for the selected metric. Each row normalizes to
  // { employeeId, name, primary (big colored number), secondary (grey badge) }.
  const topPerformers = (() => {
    if (perfMetric === "engagement") {
      return [...leaderboardRows]
        .sort((a, b) => (b.totalEngagement ?? 0) - (a.totalEngagement ?? 0))
        .slice(0, 3)
        .map((r) => ({
          employeeId: r.employee?.id ?? r.employeeId,
          name: r.employee?.name ?? r.name ?? "—",
          primary: `${fmtCompact(r.totalEngagement ?? 0)} eng`,
          secondary: `${r.totalLinks ?? 0} links`,
        }));
    }
    // Per-platform board (youtube | facebook | instagram): already ranked server-side.
    if (perfMetric === "youtube" || perfMetric === "facebook" || perfMetric === "instagram") {
      const board = platformBoards[perfMetric] ?? [];
      const isViews = perfMetric !== "instagram"; // YT/FB rank by views; IG by likes+comments
      return board.slice(0, 3).map((r: any) => ({
        employeeId: r.employee?.id ?? "—",
        name: r.employee?.name ?? "—",
        primary: isViews
          ? `${fmtCompact(r.views ?? 0)} views`
          : `${fmtCompact((r.likes ?? 0) + (r.comments ?? 0))} eng`,
        secondary: `${r.engagedLinkCount ?? 0} link${(r.engagedLinkCount ?? 0) !== 1 ? "s" : ""}`,
      }));
    }
    // links (default)
    return [...topSubmitters]
      .sort((a, b) => b.totalLinks - a.totalLinks)
      .slice(0, 3)
      .map((p) => ({
        employeeId: p.employeeId,
        name: p.name,
        primary: `${p.totalLinks} links`,
        secondary: `${p.reportCount} report${p.reportCount !== 1 ? "s" : ""}`,
      }));
  })();
```

> Note: this REMOVES the `reports` branch entirely (the user asked to drop it). The `topSubmitters` variable is still used by the default `links` branch, so it stays.

- [ ] **Step 4: Update the empty-state copy to be metric-aware (optional-but-correct)**

The Top Performers card's empty state currently says "No data in the last 30 days" (near line 701). That's still accurate for every metric, so no change is strictly required. Leave it as-is.

> The card header's `PillGroup` already maps over `PERF_METRICS` (lines 681-692), so adding the platform entries automatically renders the new pills with no JSX change. The pill row will now show 5 pills (Links / Engagement / YouTube / Facebook / Instagram) — they wrap via `PillGroup`'s `flex-wrap` on narrow cards.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p apps/internal/tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/internal/src/lib/hooks/use-reports.ts apps/internal/src/app/dashboard/page.tsx
git commit -m "feat(dashboard): Top Performers drop Reports, add per-platform ranking"
```

---

## Task 3: Fix Top Movers accuracy — suppress positive correction-artifacts (backend)

**Files:**
- Modify: `apps/api/src/services/account-growth.service.ts`
- Test: the nearest existing growth-service test file under `apps/api/tests/` (find it in Step 1)

**The fix is one predicate.** `isCorrectionArtifact` is defined once (line 336) and applied at 5 sites (`totalDelta`, `gainers`/`decliners`, `topMovers`, `topMoversByPlatform`). Widening it fixes all consumers at once — the artifact's DELTA is dropped everywhere, but (as the existing code already does) its true CURRENT follower count still counts toward `totalFollowers`.

- [ ] **Step 1: Find the growth-service test file (TDD — write the failing test first)**

Run:
```bash
ls apps/api/tests/ | grep -i "growth\|account"
grep -rl "isCorrectionArtifact\|getGrowthOverview\|topMovers" apps/api/tests/ 2>/dev/null
```
Note the path. If a growth-overview test file exists, add to it; if not, create `apps/api/tests/account-growth-artifact.test.ts`. Read one existing test in `apps/api/tests/` first to match the project's Vitest setup (imports, how Prisma is mocked, `describe`/`it` style).

- [ ] **Step 2: Write a failing test that a tiny-baseline positive spike is suppressed**

The test must exercise the pure filter logic. Since `isCorrectionArtifact` is a local closure, test it via `getGrowthOverview`'s observable output OR (cleaner) by extracting the predicate. **Preferred: extract the predicate to a tiny exported pure function** so it's unit-testable without a DB. Add to `account-growth.service.ts` near the top (module scope):

```ts
/**
 * A follower delta is a DATA-CORRECTION ARTIFACT (not organic movement) when it's a
 * ≥90% collapse (stale→real first-sync down-correction) OR a >200% surge in-window
 * (a garbage tiny baseline like 2→59,000, or a resolver oscillating between a stale and
 * real value, e.g. 10,900↔46,300). Both are measurement corrections, not real growth.
 * Verified against live prod 2026-07-13: a >200% (i.e. >3×) weekly swing matched ONLY the
 * two known artifacts ("89" +2,963,850%, "Total Filmi" +324.8%) and zero legitimate accounts.
 */
export function isFollowerCorrectionArtifact(deltaPct: number | null): boolean {
  if (deltaPct == null) return false;
  return deltaPct <= -90 || deltaPct > 200;
}
```

Then the test:

```ts
import { describe, it, expect } from "vitest";
import { isFollowerCorrectionArtifact } from "../src/services/account-growth.service";

describe("isFollowerCorrectionArtifact", () => {
  it("suppresses the negative stale→real collapse (existing behavior)", () => {
    expect(isFollowerCorrectionArtifact(-99)).toBe(true);
    expect(isFollowerCorrectionArtifact(-90)).toBe(true);
  });
  it("suppresses garbage tiny-baseline positive spikes (the '89' 2→59K = +2,963,850% case)", () => {
    expect(isFollowerCorrectionArtifact(2963850)).toBe(true);
  });
  it("suppresses the oscillation correction (Total Filmi 10,900↔46,300 = +324.8%)", () => {
    expect(isFollowerCorrectionArtifact(325)).toBe(true);
  });
  it("KEEPS legitimate growth (Paparazzi +1% on a 15M base)", () => {
    expect(isFollowerCorrectionArtifact(1)).toBe(false);
    expect(isFollowerCorrectionArtifact(15)).toBe(false); // Pap Hq +14.9%, real
  });
  it("keeps null deltaPct as non-artifact (no baseline → nothing to correct)", () => {
    expect(isFollowerCorrectionArtifact(null)).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to confirm it FAILS**

Run: `npm run test -w @dashmani/api -- account-growth-artifact` (or the matching test path)
Expected: FAIL — `isFollowerCorrectionArtifact` doesn't exist yet (you'll add it in Step 4). If you already added the function in Step 2, the tests for the `+200%` cases fail against the OLD inline predicate — either way, confirm red before green.

- [ ] **Step 4: Wire the extracted predicate into the existing filter**

In `account-growth.service.ts`, find line 336:
```ts
  const isCorrectionArtifact = (a: GrowthOverviewAccount) => a.deltaPct != null && a.deltaPct <= -90;
```
Replace with:
```ts
  // See isFollowerCorrectionArtifact (module scope) — now also drops >200% in-window
  // surges (garbage tiny baselines / oscillating resolver values), not just -90% collapses.
  const isCorrectionArtifact = (a: GrowthOverviewAccount) => isFollowerCorrectionArtifact(a.deltaPct);
```

(The module-scope `isFollowerCorrectionArtifact` from Step 2 must already be added. All 5 existing call sites — `totalDelta`, `gainers`/`decliners`, `topMovers`, `topMoversByPlatform` — inherit the fix automatically since they all call this same local `isCorrectionArtifact`.)

- [ ] **Step 5: Run the test to confirm it PASSES**

Run: `npm run test -w @dashmani/api -- account-growth-artifact`
Expected: PASS (all 5 assertions).

- [ ] **Step 6: Run the FULL api test suite to confirm no regression**

Run: `npm run test -w @dashmani/api`
Expected: no NEW failures. (CLAUDE.md notes ~36 PRE-EXISTING unrelated failures in content/analytics/task/team setup — those are not yours. Confirm your change added zero new failures by comparing against a baseline run on the untouched branch if unsure.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/account-growth.service.ts apps/api/tests/
git commit -m "fix(growth): suppress positive correction-artifacts from Top Movers

The 'is this a data-correction not real growth' filter was negative-only
(<=-90%). Verified live on prod: '89' shows +2,963,850% (baseline of 2 →
59K bad first-sync) and 'Total Filmi' +324.8% (resolver oscillating
10,900<->46,300). Widen the predicate to also drop >200% in-window surges.
A >3x weekly swing matched ONLY these two artifacts and zero legit accounts."
```

---

## Task 3b: Defense-in-depth — cap the displayed percentage in DeltaBadge

**Files:**
- Modify: `apps/internal/src/lib/hooks/use-growth.tsx`

Even with Task 3 suppressing artifacts from the *movers ranking*, a large (but legitimate) `deltaPct` could still render awkwardly elsewhere (`DeltaBadge` is also used for the Account Growth headline `totalDelta`, which has no pct, and could be reused later). Cap the *displayed* percentage as a cheap frontend safety net so no absurd number can ever reach a user, regardless of backend state.

- [ ] **Step 1: Add the cap to DeltaBadge**

In `use-growth.tsx`, find the `DeltaBadge` render (lines 94-101). Replace the `deltaPct` span:

```tsx
      {sign}{fmtCompact(d)}
      {deltaPct != null && (
        <span className="text-ink-4 font-normal">
          ({sign}{Math.abs(deltaPct) > 999 ? ">999" : deltaPct}%)
        </span>
      )}
```

> `>999%` is a readable ceiling. Combined with Task 3 (which stops such values from ranking at all), this guarantees the UI never prints `+2963850%` even if a future artifact slips the backend filter.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p apps/internal/tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/internal/src/lib/hooks/use-growth.tsx
git commit -m "fix(dashboard): cap DeltaBadge percentage display at >999%"
```

---

## Task 4: New card — Total Engagement (30d) per platform

**Files:**
- Modify: `apps/internal/src/app/dashboard/page.tsx`

A CEO's single best "is our content working" signal. `useInsightsSummary` already exists and returns `byPlatform` totals. This is the biggest attractiveness win: real views/likes/comments per platform.

- [ ] **Step 1: Import the hook**

In `page.tsx` line 8, add `useInsightsSummary`:
```tsx
import { useLinksAnalytics, useTopLinks, usePlatformLeaderboards, useInsightsSummary } from "@/lib/hooks/use-reports";
```

- [ ] **Step 2: Derive the engagement data (reuse the existing 30-day perf window)**

After the `topLinksRows` derivation (near line 186), add:

```tsx
  // Total engagement (30d) per platform — org-wide views/likes/comments. Reuses the same
  // perfStart/perfEnd 30-day window; useInsightsSummary is cached 5 min (one call).
  const { data: insightsData, isLoading: insightsLoading } = useInsightsSummary(perfStart, perfEnd);
  const insights = (insightsData as any)?.data;
  const insightsTotalViews: number = insights?.totalViews ?? 0;
  const insightsTotalLikes: number = insights?.totalLikes ?? 0;
  const insightsTotalComments: number = insights?.totalComments ?? 0;
  const insightsByPlatform: {
    platform: string; totalViews: number; totalLikes: number; totalComments: number; linkCount: number;
  }[] = (insights?.byPlatform ?? []).filter((p: any) => (p.linkCount ?? 0) > 0);
```

- [ ] **Step 3: Add the card JSX**

Insert a new card block INSIDE the bento grid, immediately BEFORE the `{/* More metrics …` block (near line 815). It spans full width to give the per-platform rows room:

```tsx
        {/* Total Engagement (30d) — org-wide, per platform. Full width. */}
        <div className="lg:col-span-3 v3-card p-5 space-y-4 v3-card-lift">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-terra-soft flex items-center justify-center">
              <TrendingUp className="h-5 w-5 text-terra" />
            </div>
            <div>
              <p className="font-bold text-ink">Total Engagement</p>
              <p className="text-xs text-ink-4">Last 30 days · views + likes + comments</p>
            </div>
          </div>

          {insightsLoading ? (
            <div className="grid grid-cols-3 gap-3 animate-pulse">
              {[0, 1, 2].map((i) => <div key={i} className="h-14 bg-muted rounded-xl" />)}
            </div>
          ) : (
            <>
              {/* Headline totals */}
              <div className="grid grid-cols-3 gap-3">
                <div className="v3-card-inset p-3 text-center">
                  <p className="font-num text-2xl font-semibold text-ink leading-none">{fmtCompact(insightsTotalViews)}</p>
                  <p className="text-[10px] text-ink-4 mt-1">Views</p>
                </div>
                <div className="v3-card-inset p-3 text-center">
                  <p className="font-num text-2xl font-semibold text-ink leading-none">{fmtCompact(insightsTotalLikes)}</p>
                  <p className="text-[10px] text-ink-4 mt-1">Likes</p>
                </div>
                <div className="v3-card-inset p-3 text-center">
                  <p className="font-num text-2xl font-semibold text-ink leading-none">{fmtCompact(insightsTotalComments)}</p>
                  <p className="text-[10px] text-ink-4 mt-1">Comments</p>
                </div>
              </div>

              {/* Per-platform breakdown */}
              {insightsByPlatform.length > 0 ? (
                <div className="space-y-2">
                  {insightsByPlatform
                    .slice()
                    .sort((a, b) => (b.totalViews + b.totalLikes + b.totalComments) - (a.totalViews + a.totalLikes + a.totalComments))
                    .map((p) => (
                      <div key={p.platform} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-1.5 border-t border-[#F0EAD8] first:border-t-0">
                        <span className="text-xs font-semibold text-ink capitalize w-24 shrink-0">{p.platform}</span>
                        <span className="text-[11px] text-ink-4">{fmtCompact(p.totalViews)} <span className="text-ink-3">views</span></span>
                        <span className="text-[11px] text-ink-4">{fmtCompact(p.totalLikes)} <span className="text-ink-3">likes</span></span>
                        <span className="text-[11px] text-ink-4">{fmtCompact(p.totalComments)} <span className="text-ink-3">comments</span></span>
                        <span className="text-[11px] text-ink-4 ml-auto">{p.linkCount} link{p.linkCount !== 1 ? "s" : ""}</span>
                      </div>
                    ))}
                </div>
              ) : (
                <p className="text-sm text-ink-4 text-center py-4">No engagement data in the last 30 days</p>
              )}
            </>
          )}

          <div className="flex justify-end">
            <Link href="/reports" className="flex items-center gap-1.5 text-xs font-semibold text-terra hover:underline">
              View full reports <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
```

> `TrendingUp` is already imported (from `lucide-react`, used by `DeltaBadge` in use-growth, but confirm it's in THIS file's import list at line 12 — if not, add it). `v3-card-inset` is an existing utility used elsewhere. IG shows 0 views by design (no reliable IG view data) — that's honest, not a bug.

- [ ] **Step 4: Confirm `TrendingUp` import**

```bash
grep -n "TrendingUp" apps/internal/src/app/dashboard/page.tsx | head -1
```
If line 12's lucide import doesn't include `TrendingUp`, add it there.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p apps/internal/tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/internal/src/app/dashboard/page.tsx
git commit -m "feat(dashboard): add Total Engagement (30d) per-platform card"
```

---

## Task 5: New card — Team leaderboard + non-submitters

**Files:**
- Modify: `apps/internal/src/app/dashboard/page.tsx`

An accountability signal a CEO wants: which teams lead on output, and who hasn't submitted. **Zero new fetch** — `teamRanks` and `nonSubmitters` are already in the `useLinksAnalytics(perfStart, perfEnd)` payload the page fetches for Top Performers.

- [ ] **Step 1: Derive team ranks + non-submitters from the ALREADY-fetched analytics**

The `linksAnalyticsData` variable (from `useLinksAnalytics(perfStart, perfEnd)`, line 117) already holds this. After the `topSubmitters` derivation (near line 119), add:

```tsx
  const teamRanks: { teamId: string; teamName: string; totalLinks: number; avgLinksPerMember: number }[] =
    (linksAnalyticsData as any)?.data?.teamRanks ?? [];
  const nonSubmitters: { employeeId: string; name: string }[] =
    (linksAnalyticsData as any)?.data?.nonSubmitters ?? [];
```

- [ ] **Step 2: Add the card JSX**

Insert INSIDE the bento grid, immediately AFTER the Top Links card's closing `</div>` (near line 813) and BEFORE the Total Engagement card from Task 4. It's a `lg:col-span-3` full-width card split into two columns (teams | non-submitters):

```tsx
        {/* Team leaderboard + non-submitters (30d) — accountability. Full width, two columns.
            Data reused from the Top Performers useLinksAnalytics payload (no extra fetch). */}
        <div className="lg:col-span-3 v3-card p-5 space-y-4 v3-card-lift">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-indigo-soft flex items-center justify-center">
              <Users className="h-5 w-5 text-indigo" />
            </div>
            <div>
              <p className="font-bold text-ink">Teams &amp; Accountability</p>
              <p className="text-xs text-ink-4">Last 30 days</p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Team leaderboard */}
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-4">Top teams by links</p>
              {topPerformersLoading ? (
                <div className="space-y-2 animate-pulse">{[0,1,2].map((i) => <div key={i} className="h-7 bg-muted rounded-lg" />)}</div>
              ) : teamRanks.length === 0 ? (
                <p className="text-sm text-ink-4 py-2">No team data</p>
              ) : (
                <ul className="space-y-2">
                  {teamRanks.slice(0, 5).map((t, i) => (
                    <li key={t.teamId} className="flex items-center gap-2">
                      <span className="text-xs font-bold text-ink-4 w-4 shrink-0">{i + 1}</span>
                      <span className="flex-1 min-w-0 text-xs font-semibold text-ink truncate" title={t.teamName}>{t.teamName}</span>
                      <span className="text-[10px] text-ink-4 bg-ink/5 rounded-full px-2 py-0.5 shrink-0">{t.avgLinksPerMember}/member</span>
                      <span className="text-xs font-semibold text-indigo shrink-0">{fmtCompact(t.totalLinks)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Non-submitters */}
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-4">
                Haven't submitted {nonSubmitters.length > 0 ? `(${nonSubmitters.length})` : ""}
              </p>
              {topPerformersLoading ? (
                <div className="space-y-2 animate-pulse">{[0,1,2].map((i) => <div key={i} className="h-7 bg-muted rounded-lg" />)}</div>
              ) : nonSubmitters.length === 0 ? (
                <p className="text-sm text-sage py-2">Everyone has submitted 🎉</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {nonSubmitters.slice(0, 12).map((e) => (
                    <Link
                      key={e.employeeId}
                      href={`/reports/${e.employeeId}`}
                      className="text-[11px] text-ink-3 bg-muted rounded-full px-2.5 py-1 hover:bg-ink/10 transition-colors truncate max-w-[10rem]"
                      title={e.name}
                    >
                      {e.name}
                    </Link>
                  ))}
                  {nonSubmitters.length > 12 && (
                    <span className="text-[11px] text-ink-4 px-2.5 py-1">+{nonSubmitters.length - 12} more</span>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex justify-end">
            <Link href="/reports/links" className="flex items-center gap-1.5 text-xs font-semibold text-indigo hover:underline">
              View full analytics <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
```

> `nonSubmitters` from `getLinksAnalytics` = active employees with zero links in the window. Note: this is a 30-day window (matching the card), so "haven't submitted" means "no links in 30 days" — the label "Haven't submitted" is accurate at the 30-day granularity. `topPerformersLoading` is reused as the loading flag since it's the same `useLinksAnalytics` call.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p apps/internal/tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/internal/src/app/dashboard/page.tsx
git commit -m "feat(dashboard): add Teams & Accountability card (team ranks + non-submitters)"
```

---

## Task 6: Full build + verification gate (MANDATORY)

**Files:** none (verification)

- [ ] **Step 1: Full monorepo build**

```bash
cd /Users/tabish/Desktop/dashmani-platform
npm run build
```
Expected: all 5 apps build clean.

- [ ] **Step 2: Full api test suite (the backend change)**

```bash
npm run test -w @dashmani/api
```
Expected: the new `isFollowerCorrectionArtifact` tests pass; zero NEW failures vs the pre-existing baseline.

- [ ] **Step 3: Start dev servers + open the dashboard**

```bash
lsof -ti:3000,4000 | xargs kill -9 2>/dev/null; true
# ensure docker (postgres+redis) is up: docker-compose up -d
npm run dev
```
Log in (admin@digitalsukoon.com) → `http://localhost:3000/dashboard`. (Local dev DB has sparse data, so verify STRUCTURE + no crashes here; verify the ACCURACY fix against prod in Step 6.)

- [ ] **Step 4: Click-through — confirm no crash, correct behavior**

- **Account Growth:** shows the "Followers by platform" bars filling the card; "View all" sits at the bottom, no dead whitespace. Switch 7d/30d/90d — headline + bars update.
- **Top Performers:** exactly 5 pills (Links / Engagement / YouTube / Facebook / Instagram), NO "Reports". Click each — list re-ranks; platform tabs show "N views"/"N eng"; empty platforms show the empty state, no crash.
- **Top Movers:** switch platform pills; confirm no absurd percentage badge renders.
- **Total Engagement card:** 3 headline tiles (Views/Likes/Comments) + per-platform rows; IG shows 0 views (correct).
- **Teams & Accountability card:** team list + non-submitter chips (or "Everyone has submitted 🎉" / "No team data" empty states).

- [ ] **Step 5: Console + mobile check**

- DevTools console: zero red errors (a missing-favicon 404 is pre-existing and fine) after clicking every pill.
- Resize to 390px: every pill group + the new full-width cards' internal columns wrap without horizontal page scroll.

- [ ] **Step 6: Verify the accuracy fix against LIVE prod data (the whole point of Task 3)**

Point the local frontend at prod API (or inspect the prod `/admin/growth?days=7` response with an admin token), and confirm the Top Movers board **no longer shows "89 +2,963,850%" or "Total Filmi +324.8%"**, while legitimate movers (Paparazzi +153.9K/+1%, etc.) remain. Alternatively, after this ships, re-run the prod DB query from the plan's findings section and confirm the artifact accounts would now be filtered (`deltaPct > 200` → suppressed).

```bash
# Read-only prod sanity check (confirms the two artifacts are the only >200% swings):
ssh linode 'sudo -u postgres psql -d dashmani_prod -t -A -F"|" -c "
WITH win AS (SELECT account_id,(array_agg(follower_count ORDER BY date ASC))[1] AS f,(array_agg(follower_count ORDER BY date DESC))[1] AS l FROM account_growth_snapshots WHERE date >= CURRENT_DATE - INTERVAL '"'"'7 days'"'"' GROUP BY account_id)
SELECT sa.display_name, round(((l-f)::numeric/nullif(f,0))*100) pct FROM win w JOIN social_accounts sa ON sa.id=w.account_id WHERE f>0 AND (l::numeric/f)>3;"'
# Expect ONLY: 89 (2963800), Total Filmi (325). Both now suppressed by the widened filter.
```

- [ ] **Step 7: Stop dev servers**

```bash
lsof -ti:3000,4000 | xargs kill -9 2>/dev/null; true
```

---

## Task 7: PR

**Files:** none

> Covers the dashboard work (Tasks 1–6). **Task 9 (HR `/report` Safari fix) is a separate `apps/hr` change and should be its own branch + PR** — do it before OR after this one, independently. If you prefer a single PR for everything, that's acceptable too since they don't conflict, but separate PRs keep the HR CSS fix reviewable on its own and shippable faster.

- [ ] **Step 1: Push and open PR against main**

```bash
git push -u origin feat/dashboard-v2-polish
gh pr create --base main --title "feat(dashboard): CEO card polish, per-platform Top Performers, accuracy fix + 2 new cards" --body "$(cat <<'EOF'
## Summary
Follow-up to #90. Frontend-focused; one surgical backend predicate change (no new query/endpoint/schema, no db:push).

- **Account Growth:** filled the stretched whitespace with an accurate per-platform follower-bar breakdown (summed client-side from data already in the payload — zero new load). "View all" now anchors to the bottom.
- **Top Performers:** removed the "Reports" pill; added per-platform ranking (YouTube/Facebook by views, Instagram by likes+comments) via the existing `getPlatformLeaderboards` endpoint + a new `usePlatformLeaderboards` hook. Kept Links + Engagement.
- **Top Movers accuracy fix (verified on live prod):** the "is this a data correction, not real growth" filter was negative-only (≤-90%). Live data showed "89" rendering **+2,963,850%** (bad baseline of 2 → real 59K first-sync) and "Total Filmi" **+324.8%** (resolver oscillating 10,900↔46,300). Widened the predicate to also drop >200% in-window surges — a >3× weekly swing matched ONLY these two artifacts and zero legitimate accounts. Plus a `>999%` display cap in `DeltaBadge` as defense-in-depth.
- **New card — Total Engagement (30d) per platform:** org-wide views/likes/comments + per-platform breakdown (`useInsightsSummary`, existing hook).
- **New card — Teams & Accountability:** top teams by links + who hasn't submitted (reuses the `useLinksAnalytics` payload the page already fetches — no extra call).

## Accuracy
Verified against the live prod database, not assumed. Top Performers link counts confirmed dupe-free; Account Growth totals confirmed trustworthy; the only inaccuracy was the Top Movers positive-artifact leak, now fixed at the root.

## Test Plan
- [ ] `tsc --noEmit` clean (internal)
- [ ] Full `npm run build` green (all apps)
- [ ] `npm run test -w @dashmani/api` — new `isFollowerCorrectionArtifact` tests pass, no new failures
- [ ] Live browser: every pill on every card clicked, zero console errors, 390px wraps cleanly
- [ ] Prod check: "89" / "Total Filmi" artifacts no longer top Top Movers

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Task 9: Fix HR `/report` iOS-Safari overflow that persists in "Desktop Site" mode

**Files:**
- Modify: `apps/hr/src/app/globals.css`

**⚠️ This is a separate bug in a DIFFERENT app (`apps/hr`, not `apps/internal`).** It shares no code with Tasks 1–8 and can be shipped as its own commit/PR. It is included here because it surfaced during this review cycle.

### Root cause — VERIFIED IN REAL WEBKIT (not hypothesized)

**Symptom (from a user's iOS screen-recording):** on `hr.digitalsukoon.com/report`, the whole page content shifts/clips horizontally (cards, inputs, and the submit button get cut off at the left or right edge depending on scroll position). It reproduces for **only some Safari users** and — the key clue — **persists even after switching Safari to "Desktop Site" mode**.

**It is NOT a CSS box-width bug.** Every container on the `/report` page is correctly constrained (`max-w-3xl`, `min-w-0`, `overflow-hidden` on the card, `w-full max-w-full min-w-0` on inputs/selects, `accountOptionLabel()` caps the `<select>` option text). A static-analysis pass finds nothing wrong — and prod IS running the fixed code (`origin/main` = prod `6800dda` has `accountOptionLabel` at both option sites). So the box model is a dead end.

**The actual mechanism (iOS Safari focus-auto-zoom):** iOS Safari **auto-zooms the visual viewport** whenever the user focuses an input whose computed `font-size < 16px`, and the zoomed viewport then **pans horizontally** — producing exactly the shift/clip in the video. No `overflow-x: hidden` can stop a browser-level zoom-pan. The HR app already knows this: `apps/hr/src/app/globals.css:50-54` has a 16px font-floor to prevent it:

```css
@media (hover: none) and (pointer: coarse) {
  input[class], textarea[class], select[class],
  input, textarea, select {
    font-size: 16px !important;
  }
}
```

**Why it fails in Desktop Site mode:** the floor is gated behind `@media (hover: none) and (pointer: coarse)`. When Safari is in **"Desktop Site" mode**, it presents a desktop-class environment that reports **`hover: hover` / `pointer: fine`**, so this media query **stops matching** → the 16px floor turns OFF → the `/report` inputs revert to their Tailwind sizes (`text-sm` = 14px, `!text-xs` = 12px) → both `< 16px` → iOS resumes auto-zoom-on-focus → the overflow returns. iOS remembers "Desktop Site" **per-domain**, so "only some users" = only those iOS users who toggled Desktop Site for `hr.digitalsukoon.com` (a common tap in Safari's `aA` menu).

**Empirical proof (ran the actual WebKit engine — Playwright `webkit`, i.e. Safari's engine — against a DOM replicating the `/report` inputs + globals.css):**

| Context | `matchMedia("(hover:none) and (pointer:coarse)")` | URL input font-size | metric input font-size |
|---|---|---|---|
| iPhone 14 (normal mobile Safari) | `true` | **16px** (floor applies → no zoom) | **16px** (safe) |
| Desktop Site mode (desktop context) | `false` | **14px** (floor OFF → iOS zooms) | **12px** (iOS zooms) |

The `false` row is the bug. (Chromium — which the Playwright MCP uses — has no iOS auto-zoom, which is why this was invisible to earlier browser checks and must be verified in WebKit specifically.)

> **Contributing data-quality aggravator (out of scope here, note only):** prod has `report_links.url` rows up to **719 chars** — multiple URLs concatenated into one field (space-separated blobs from paste-and-autosort), plus single ~200-char IG URLs. These make the zoomed-pan overflow more pronounced when present, but they are NOT the cause (the inputs scroll their value internally at 16px). A separate cleanup of multi-URL blobs in `report_links.url` could be a future data task; it is deliberately NOT bundled into this CSS fix.

### The fix — remove the Desktop-Site escape hatch from the font floor

The floor must apply whenever iOS *could* auto-zoom, regardless of the reported pointer/hover capability (which Desktop Site spoofs). A 16px floor on focusable form controls is **completely harmless on real desktop** (desktop browsers never auto-zoom, and 16px inputs render fine), so the safest, most robust fix is to **stop gating the floor behind the coarse-pointer media query for the form controls** and apply it unconditionally. Real desktop users lose nothing; iOS-in-Desktop-Site users regain the protection.

- [ ] **Step 1: Replace the media-query-gated floor with an ungated one**

In `apps/hr/src/app/globals.css`, find the block at lines ~50-54:

```css
@media (hover: none) and (pointer: coarse) {
  input[class], textarea[class], select[class],
  input, textarea, select {
    font-size: 16px !important;
  }
}
```

Replace it with (keep the existing explanatory comment block above it; update its last lines to reflect the new reasoning):

```css
/* Apply the 16px floor UNCONDITIONALLY (not gated behind (hover:none) and
   (pointer:coarse)). iOS Safari's "Desktop Site" mode reports hover:hover /
   pointer:fine, which turned the old coarse-pointer-gated floor OFF and re-armed
   the focus-auto-zoom + horizontal-pan overflow on /report (verified in WebKit
   2026-07-13: the media query evaluates false in Desktop Site mode, so inputs
   fell back to 12–14px). A 16px floor on focusable controls is harmless on real
   desktop (no browser auto-zooms; 16px inputs render fine), so ungating it fixes
   iOS-in-Desktop-Site users at zero cost to everyone else.
   The [class] attribute selector keeps specificity at (0,1,1) so we still beat
   Tailwind's !important utilities (!text-xs / text-sm at (0,1,0)). */
input[class], textarea[class], select[class],
input, textarea, select {
  font-size: 16px !important;
}
```

> **Why not just add a second `@media` for desktop?** Because Desktop Site mode is indistinguishable from a real small desktop window via media queries alone — there's no media feature that says "iOS pretending to be desktop." Ungating is the only reliable fix. The downside (16px form controls on genuine desktop) is a non-issue: the HR portal's desktop inputs are already comfortable at 16px, and nothing else in the app depends on sub-16px focusable controls.

- [ ] **Step 2: Confirm no OTHER HR page relied on the coarse-pointer gate for sub-16px inputs**

Run:
```bash
grep -rn "hover: none\|pointer: coarse" apps/hr/src/
```
Expected: the only occurrence was the one you just changed. If other rules use that gate for legitimately different purposes (e.g. hiding a hover-only affordance), leave those untouched — you only changed the font-floor rule.

- [ ] **Step 3: Re-verify the fix in real WebKit (MANDATORY — Chromium can't show this bug)**

Install WebKit if needed (`npx playwright install webkit`), then run a WebKit check that loads the built HR `/report` page (or a DOM replicating its inputs + the edited globals.css) in BOTH an `iPhone 14` context AND a desktop-class (no-touch) context, and assert the URL/metric input computed `font-size === "16px"` in BOTH. Expected after the fix:

| Context | URL input font-size | metric input font-size |
|---|---|---|
| iPhone 14 | **16px** | **16px** |
| Desktop Site (no-touch, 980px) | **16px** ✅ (was 14px) | **16px** ✅ (was 12px) |

The Desktop-Site row flipping to 16px is the proof the fix works. (A ready pattern: `webkit.launch()` → `browser.newContext(devices["iPhone 14"])` and a second `newContext({ viewport: {width:980,height:1300} })` → `getComputedStyle(input).fontSize`.)

- [ ] **Step 4: Full HR build**

Run: `npm run build -w @dashmani/hr`
Expected: clean. (A CSS-only change won't break TS, but build confirms the stylesheet compiles.)

- [ ] **Step 5: Commit**

```bash
git add apps/hr/src/app/globals.css
git commit -m "fix(hr): stop /report inputs auto-zooming in iOS Safari Desktop Site mode

The 16px input font-floor (which prevents iOS Safari's focus-auto-zoom +
horizontal-pan overflow on /report) was gated behind
@media (hover:none) and (pointer:coarse). iOS 'Desktop Site' mode reports
hover:hover/pointer:fine, so the query evaluated false, the floor turned off,
inputs fell back to 12-14px, and the zoom-overflow returned — reproducing for
users who had Desktop Site toggled on (verified in WebKit). Apply the floor
unconditionally; harmless on real desktop, fixes iOS-in-Desktop-Site."
```

---

## Self-Review

**Spec coverage (against the user's message):**
- ✅ "accounts growth takes up a lot of white space and 'view all' is located very above it" → Task 1 (platform follower bars fill the body; View all anchors bottom).
- ✅ "top performers does not require the option of reports" → Task 2 Step 3 (removes the `reports` branch + pill).
- ✅ "it does require option to select per platform (remember our leaderboards)" → Task 2 (YouTube/Facebook/Instagram pills via `getPlatformLeaderboards`, same fair per-platform logic as the leaderboards page).
- ✅ "the rest are fine options" → Links + Engagement kept.
- ✅ "showcase these metrics in any other form to make it look more attractive" → follower bars (Task 1), engagement tiles + per-platform rows (Task 4), team bars + non-submitter chips (Task 5).
- ✅ "any more use cases that a CEO might require" → Total Engagement + Teams/Accountability (Tasks 4, 5), both chosen from the verified inventory, no bloat.
- ✅ "no need to add previous cards back again as they/those filters were not required" → does NOT re-add removed cards/filters.
- ✅ "Is the data being displayed accurate?" → findings section documents the verified accuracy audit; Task 3 fixes the one real bug (positive correction-artifacts).
- ✅ "no crashing issues or more load on our portals, no previous errors must resurface" → guardrails section; every new card reuses already-fetched data or an existing cached hook; the backend change adds zero queries; explicitly avoids the P2024 pool-exhaustion risk.
- ✅ "UI issue for certain mobile users persists even after changing to desktop site (select safari users) — discover the root cause and update the plan" → Task 9. Root cause VERIFIED IN WEBKIT: the HR `/report` 16px input font-floor is gated behind `@media (hover:none) and (pointer:coarse)`, which stops matching in iOS "Desktop Site" mode → inputs fall to 12-14px → iOS focus-auto-zoom + horizontal-pan overflow. "Only some users" = only those with Desktop Site toggled on (per-domain). Fix: apply the floor unconditionally (harmless on real desktop).

**Placeholder scan:** No TBD/TODO — every step has concrete code.

**Type consistency:** `topPerformers` stays normalized to `{employeeId, name, primary, secondary}` across all branches (Task 2). `growthByPlatform` `{platform, followers}` defined + consumed in Task 1. `insightsByPlatform`/`teamRanks`/`nonSubmitters` typed inline and consumed with matching keys (Tasks 4, 5). `isFollowerCorrectionArtifact(deltaPct: number|null): boolean` defined in Task 3 Step 2 and called in Step 4 + tests. `usePlatformLeaderboards` signature matches its dashboard usage.

**Known assumptions (flagged for the implementer):**
1. Task 3 assumes `isCorrectionArtifact` is still the single predicate applied at all 5 sites on `main` — verified true at plan-writing time (line 336). If the implementer finds it changed, adjust in place (the intent is: widen the ONE predicate, don't add a parallel one).
2. `getInsightsSummary.byPlatform` includes platforms with `linkCount: 0` — Task 4 Step 2 filters those out (`linkCount > 0`) so the card doesn't show empty platform rows.
3. Task 5's `nonSubmitters` is 30-day-window scoped (from `getLinksAnalytics`), so the label means "no links in 30 days," not "didn't submit today" — the copy ("Haven't submitted") is accurate at that granularity; if a stricter "today" semantic is wanted later, that's a separate change.
4. Task 9 is an INDEPENDENT `apps/hr` CSS fix — it touches no dashboard code and can be a separate commit/PR. Its verification MUST use real WebKit (Playwright `webkit`), not Chromium/the Playwright MCP (Chromium has no iOS auto-zoom and cannot reproduce or confirm the fix). The root cause was proven in WebKit during planning, not assumed.
5. Task 9's fix intentionally makes ALL focusable HR form controls ≥16px on every device. If any HR screen deliberately relies on a sub-16px focusable input for layout (none found — `grep` showed the coarse-pointer gate was used only by the font-floor rule), reconcile that there; the trade is accepted because desktop browsers don't auto-zoom and 16px controls render fine.
