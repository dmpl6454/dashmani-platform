# CEO Dashboard — Card Filter Pills & UI/UX Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add simple, click-to-toggle filter pills to the four glance cards on the internal-portal CEO dashboard (Top Movers, Account Growth, Top Performers, Top Links) so each card is no longer locked to a single dimension — plus fix the specific UI defects visible in the screenshot (truncated Top Movers names, YouTube-only Top Links, links-only Top Performers) — all **frontend-only**, reusing endpoints that already exist, with zero risk of crashes or backend changes.

**Architecture:** All work happens in one file — `apps/internal/src/app/dashboard/page.tsx` — plus one tiny shared pill helper. Each card gets its own independent, non-persisted pill state (`useState`). Pills swap which **existing** SWR hook / query param the card reads; they never touch the API, DB, cron, or any other page. The dashboard already conditionally fires per-platform hooks (`useTopLinks("youtube"|…)`) and the growth response already carries `topMoversByPlatform` and the leaderboard/analytics endpoints already return alternative ranking fields — so every pill is a read-path re-selection, not new data plumbing.

**Tech Stack:** Next.js 14 App Router (client component), SWR, Tailwind (semantic tokens: `text-ink`, `text-ink-4`, `bg-terra`, `bg-indigo`, `bg-sage`, `v3-card`), lucide-react icons, recharts (already imported). No new dependencies.

---

## ⚠️ CRITICAL PRE-FLIGHT — READ BEFORE ANY WORK

**The screenshot the user showed is the CEO dashboard that lives ONLY on `main` (commit `01bc282`, "feat(internal): CEO dashboard redesign", PR #89).** The current checked-out branch `feat/per-platform-leaderboards` **does NOT contain these four cards** — its `dashboard/page.tsx` ends at the "Links Activity" bento. If you implement against the current branch you will be editing a file that doesn't have the cards.

**Therefore Task 0 (branch off `main`) is mandatory and must be done first.** Verify before starting:

```bash
cd /Users/tabish/Desktop/dashmani-platform
git merge-base --is-ancestor 01bc282 HEAD && echo "HAS cards" || echo "MISSING cards — must branch off main"
grep -c "Top Movers" apps/internal/src/app/dashboard/page.tsx   # expect 0 on current branch, ≥1 after branching off main
```

**Non-negotiable guardrails (the user explicitly asked for "no sabotage or site issues/crashes or unexpected errors whatsoever"):**
- **Frontend-only.** Do NOT edit anything under `apps/api/`, `packages/db/`, cron, or services. No `db:push`. No new endpoints.
- **Reuse existing hooks only.** Every hook/endpoint referenced below already exists on `main` and is verified in this plan. Do not invent new ones.
- **Independent, non-persisted pill state** (confirmed with user): each card owns its own `useState`; no localStorage, no URL params, no cross-card coupling.
- **Every card must keep its existing empty/loading/guard states.** The dashboard already null-guards every field (`?? 0`, `?? []`, `httpUrlOrNull`, `fmtCompact` null-safe). Preserve that — a pill that selects a platform with no data must show the existing empty state, never crash.
- **Verification per CLAUDE.md:** `npx tsc --noEmit -p apps/internal/tsconfig.json` AND a full `npm run build` (all apps, because auth/shared imports only surface in the full build) must both pass before declaring done. Then a live browser check of every pill on every card.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `apps/internal/src/app/dashboard/page.tsx` | The CEO dashboard page. Holds all four cards + Links Activity. | **Modify** — add pill state + pill UI + read-path switches to each card. This is ~90% of the work. |
| `apps/internal/src/app/dashboard/_pills.tsx` | Small shared presentational pill button + pill-group, so all four cards + Links Activity render pills identically. | **Create** — one tiny stateless component (~40 lines). |

**Why a shared `_pills.tsx` (mirrors the reports module's `_range.tsx` convention):** the screenshot shows five pill groups will exist (Links Activity already has one; four new ones). Without a shared component you copy-paste the active/inactive class strings five times and they drift (the codebase already has THREE divergent pill implementations — `_range.tsx` uses ink-active, `growth/page.tsx` uses ink-active, the dashboard Links Activity uses terra-active). One `<Pill>` component keeps them consistent and is trivially safe (pure, no state, no data). The `_` prefix keeps Next.js from treating it as a route (same trick as `reports/_range.tsx`).

---

## Verified backend capabilities (NO backend work — reference only)

Every pill below maps to something the API already returns on `main`. Confirmed by reading the code:

| Card | Pill dimension | Existing hook / endpoint | How the data is already there |
|------|----------------|--------------------------|-------------------------------|
| **Top Links** | Platform: YouTube / Instagram / Facebook | `useTopLinks(platform, start, end, limit)` → `GET /admin/reports/top-links?platform=…` | Backend `getTopLinksByPlatform` accepts any platform; auto-sorts YouTube by **views**, IG/FB by **likes+comments** (`social-insights.service.ts:214,249`). Each returned link row carries `views`, and (for IG/FB) engagement — the compact card currently only reads `views`. |
| **Top Performers** | Metric: Links / Reports / Engagement | `useLinksAnalytics(start,end)` (current, gives `topSubmitters` w/ `totalLinks` + `reportCount`) **and** `useSWR('/admin/reports/leaderboard')` → `getLeaderboard` | `getLeaderboard` returns per-employee `totalLinks`, `totalReports`, `currentStreak`, `totalEngagement`, `engagementViews/Likes/Comments` (`leaderboard.service.ts:174-188`) — all ranking dimensions already computed. |
| **Account Growth** | Platform: All / per-platform | `useGrowthOverview(30)` (already called) | Response carries `topMoversByPlatform: Record<platform, TopMover[]>` and per-account `platform` (`account-growth.service.ts:219`). Platform totals derivable client-side from the same payload. **No new fetch.** |
| **Account Growth** | Window: 7d / 30d / 90d | `useGrowthOverview(days)` → `GET /admin/growth?days=N` | Route clamps `days` (default 30). Changing the arg re-fetches a new SWR key. |
| **Top Movers** | Platform: All / per-platform | `useGrowthOverview(30)` → `topMoversByPlatform` | Same payload as Account Growth — pick the platform's array vs the combined `topMovers`. |
| **Top Movers** | Window: 7d / 30d / 90d | `useGrowthOverview(days)` | Same as Account Growth window. |
| **Links Activity** | Extra: platform breakdown | `useLinksAnalytics(start,end)` → `platformBreakdown` | Already returned; not yet rendered on the dashboard card. |

**Sort-metric honesty note (must be respected in the UI copy):** the existing code comment at the Top Links card (`page.tsx:571-574` on main) documents *why* it was YouTube-only: IG/FB use different engagement mechanics (likes+comments, not views) so a single "views" column misrepresents them. The plan resolves this correctly — when the platform pill is IG or FB, the card shows the **likes+comments** metric with a per-platform label, NOT a fake "views" number. This is why the fix is a platform *pill* (one platform at a time, labeled by its real metric) rather than merging all three into one ranked list.

---

## UI/UX sizing decisions (from the screenshot review)

The screenshot shows real defects beyond the pills. Fold these into the relevant tasks:

1. **Top Movers names truncated to "Bollywood R…", "Bollywoo…".** Cause: the card is `lg:col-span-1` (1/3 width) but packs rank + name + platform badge + external-link icon + delta badge on one row. Fix: give the name row more room by moving the platform badge + delta onto a second line on narrow cards, OR widen the card. Decision in Task 6.
2. **Cards are unevenly sized** — Account Growth (`col-span-2`) next to Top Movers (`col-span-1`), then Top Performers (`col-span-2`) next to Top Links (`col-span-1`). This 2+1 rhythm is intentional and fine; keep it. Do NOT make all four equal — the "list" cards (Movers, Links) are narrower on purpose.
3. **Pills must not overflow on mobile.** Every pill group uses `flex flex-wrap gap-2` so pills wrap instead of causing horizontal scroll (the repo has a documented history of `<select>`/row overflow from long IG handles — see CLAUDE.md HR /report mobile incident). Verify at 390px.

---

## Task 0: Branch off `main` (MANDATORY FIRST)

**Files:** none (git only)

- [ ] **Step 1: Fetch and branch from main**

```bash
cd /Users/tabish/Desktop/dashmani-platform
git fetch origin main
git checkout -b feat/dashboard-card-pills origin/main
```

- [ ] **Step 2: Verify the cards exist on this branch**

Run:
```bash
grep -c "Top Movers" apps/internal/src/app/dashboard/page.tsx
grep -c "see full breakdown for Instagram" apps/internal/src/app/dashboard/page.tsx
```
Expected: both print `1` (or ≥1). If they print `0`, you are on the wrong branch — STOP and re-do Step 1.

- [ ] **Step 3: Confirm the app builds cleanly BEFORE any change (baseline)**

Run:
```bash
npx tsc --noEmit -p apps/internal/tsconfig.json
```
Expected: no errors. This is your baseline — if it errors now, that's a pre-existing issue to note, not something you introduced.

---

## Task 1: Create the shared `<Pill>` component

**Files:**
- Create: `apps/internal/src/app/dashboard/_pills.tsx`

- [ ] **Step 1: Write the component**

```tsx
// apps/internal/src/app/dashboard/_pills.tsx
// Shared, stateless pill button used by every dashboard glance card so all pill
// groups look identical. Pure presentational — no state, no data, no side effects.
// The `_` prefix keeps Next.js from routing this file (same convention as reports/_range.tsx).
"use client";
import type { ReactNode } from "react";

// Accent lets each card tint its active pill to match the card's icon color:
// terra for links, indigo for growth, sage for performers.
type Accent = "terra" | "indigo" | "sage";

const ACTIVE: Record<Accent, string> = {
  terra: "bg-terra text-white border-terra",
  indigo: "bg-indigo text-white border-indigo",
  sage: "bg-sage text-white border-sage",
};
const HOVER: Record<Accent, string> = {
  terra: "hover:border-terra/30 hover:text-terra",
  indigo: "hover:border-indigo/30 hover:text-indigo",
  sage: "hover:border-sage/30 hover:text-sage",
};

export function Pill({
  active,
  accent = "indigo",
  onClick,
  children,
}: {
  active: boolean;
  accent?: Accent;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`h-7 px-3 rounded-full text-xs font-semibold transition-all border-2 whitespace-nowrap ${
        active ? ACTIVE[accent] : `bg-surface text-ink-4 border-ink/12 ${HOVER[accent]}`
      }`}
    >
      {children}
    </button>
  );
}

// Wrapper that wraps pills on small screens instead of overflowing (390px-safe).
export function PillGroup({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}
```

- [ ] **Step 2: Verify it type-checks in isolation**

Run:
```bash
npx tsc --noEmit -p apps/internal/tsconfig.json
```
Expected: no new errors (the file isn't imported yet, but tsc will still parse it).

- [ ] **Step 3: Commit**

```bash
git add apps/internal/src/app/dashboard/_pills.tsx
git commit -m "feat(dashboard): add shared Pill component for glance-card filters"
```

---

## Task 2: Wire pills into Top Links (platform: YouTube / Instagram / Facebook)

**Files:**
- Modify: `apps/internal/src/app/dashboard/page.tsx`

This is the highest-value fix (the screenshot's "must not represent just YouTube"). The dashboard currently calls `useTopLinks("youtube", …)` once. We add a platform pill and fire the hook for the *selected* platform. Because SWR hooks must be called unconditionally, we call all three but only render the active one — OR (cleaner) call one hook with a variable platform. **Call one hook with a variable platform** — SWR re-keys automatically when the arg changes, and it avoids three simultaneous fetches.

- [ ] **Step 1: Add the import for the Pill component**

At the top of `page.tsx`, in the existing import block, add:

```tsx
import { Pill, PillGroup } from "./_pills";
```

- [ ] **Step 2: Replace the fixed YouTube hook with a platform-driven one**

Find (near line 98 on main):

```tsx
  const { data: topYouTubeData, isLoading: topLinksLoading } = useTopLinks("youtube", perfStart, perfEnd, 3);
  const topYouTubeLinks: { linkId: string | null; url: string; employeeName: string; views: number | null }[] =
    (topYouTubeData as any)?.data ?? [];
```

Replace with:

```tsx
  // Top Links platform pill — independent, non-persisted. YouTube ranks by views;
  // Instagram/Facebook rank by likes+comments (backend does this automatically).
  const TOP_LINK_PLATFORMS = [
    { key: "youtube", label: "YouTube", metric: "views" as const },
    { key: "instagram", label: "Instagram", metric: "engagement" as const },
    { key: "facebook", label: "Facebook", metric: "engagement" as const },
  ];
  const [topLinkPlatform, setTopLinkPlatform] = useState("youtube");
  const activeLinkPlatform = TOP_LINK_PLATFORMS.find((p) => p.key === topLinkPlatform) ?? TOP_LINK_PLATFORMS[0];
  const { data: topLinksData, isLoading: topLinksLoading } = useTopLinks(topLinkPlatform, perfStart, perfEnd, 3);
  const topLinksRows: {
    linkId: string | null; url: string; employeeName: string;
    views: number | null; likes: number | null; comments: number | null;
  }[] = (topLinksData as any)?.data ?? [];
```

> Note: the backend `top-links` rows for IG/FB include `likes`/`comments`; for YouTube those may be null. We render the metric per the active platform, so null on the unused metric is never displayed.

- [ ] **Step 3: Add the pill group to the Top Links card header**

Find the Top Links card header block (near line 575-584 on main):

```tsx
        <div className="lg:col-span-1 v3-card p-5 space-y-4 v3-card-lift">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-terra-soft flex items-center justify-center">
              <Eye className="h-5 w-5 text-terra" />
            </div>
            <div>
              <p className="font-bold text-ink">Top Links</p>
              <p className="text-xs text-ink-4">Last 30 days</p>
            </div>
          </div>
```

Replace with (adds the pill group under the header, using `flex-col` so pills sit below the title in this narrow card):

```tsx
        <div className="lg:col-span-1 v3-card p-5 space-y-4 v3-card-lift">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-terra-soft flex items-center justify-center">
              <Eye className="h-5 w-5 text-terra" />
            </div>
            <div>
              <p className="font-bold text-ink">Top Links</p>
              <p className="text-xs text-ink-4">Last 30 days</p>
            </div>
          </div>
          <PillGroup>
            {TOP_LINK_PLATFORMS.map((p) => (
              <Pill
                key={p.key}
                accent="terra"
                active={topLinkPlatform === p.key}
                onClick={() => setTopLinkPlatform(p.key)}
              >
                {p.label}
              </Pill>
            ))}
          </PillGroup>
```

- [ ] **Step 4: Update the list rendering + empty state + footer note to use the active platform**

Find the loading/empty/list block + the footnote (near lines 586-629 on main). Replace the `topYouTubeLinks` references, empty-state copy, per-row metric, and the hardcoded footnote:

```tsx
          {topLinksLoading ? (
            <div className="space-y-2 animate-pulse">
              {[0, 1, 2].map((i) => <div key={i} className="h-8 bg-muted rounded-lg" />)}
            </div>
          ) : topLinksRows.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-sm text-ink-4">No {activeLinkPlatform.label} links in the last 30 days</p>
            </div>
          ) : (
            <ul className="space-y-2">
              {topLinksRows.map((link, i) => {
                const safeLinkUrl = httpUrlOrNull(link.url);
                // YouTube ranks by views; IG/FB by likes+comments (no reliable views).
                const metricValue =
                  activeLinkPlatform.metric === "views"
                    ? link.views
                    : (link.likes ?? 0) + (link.comments ?? 0);
                return (
                  <li key={link.linkId ?? link.url} className="flex items-center gap-2">
                    <span className="text-xs font-bold text-ink-4 w-4 shrink-0">{i + 1}</span>
                    {safeLinkUrl ? (
                      <a
                        href={safeLinkUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 min-w-0 text-xs font-semibold text-ink hover:underline truncate"
                        title={link.url}
                      >
                        {link.url}
                      </a>
                    ) : (
                      <span
                        className="flex-1 min-w-0 text-xs font-semibold text-ink truncate"
                        title={link.url}
                      >
                        {link.url}
                      </span>
                    )}
                    <span className="text-[10px] text-ink-4 truncate max-w-[5rem] shrink-0">{link.employeeName}</span>
                    <span className="text-xs font-semibold text-terra shrink-0">{fmtCompact(metricValue)}</span>
                  </li>
                );
              })}
            </ul>
          )}

          <p className="text-[10px] text-ink-4">
            {activeLinkPlatform.metric === "views"
              ? `${activeLinkPlatform.label} · by views`
              : `${activeLinkPlatform.label} · by likes + comments`}
          </p>
```

> The old hardcoded footnote `"YouTube · by views — see full breakdown for Instagram & Facebook"` is removed — the platform is now selectable, so the note describes the active platform's real metric.

- [ ] **Step 5: Type-check**

Run:
```bash
npx tsc --noEmit -p apps/internal/tsconfig.json
```
Expected: no errors. If `fmtCompact` complains about `number | null`, confirm it's null-safe (it is on main — CLAUDE.md notes it was made null-safe in PR #38). If not, wrap: `fmtCompact(metricValue ?? 0)`.

- [ ] **Step 6: Commit**

```bash
git add apps/internal/src/app/dashboard/page.tsx
git commit -m "feat(dashboard): Top Links platform pills (YouTube/Instagram/Facebook)"
```

---

## Task 3: Wire pills into Top Performers (metric: Links / Reports / Engagement)

**Files:**
- Modify: `apps/internal/src/app/dashboard/page.tsx`

The screenshot's "must also not be limited to only those who submit links." The current card uses `useLinksAnalytics().topSubmitters` (links only). Add a metric pill. `topSubmitters` already carries `totalLinks` + `reportCount`; for the **Engagement** metric we need per-employee engagement, which `getLeaderboard` provides. So the "Links" and "Reports" pills re-sort the existing `topSubmitters`, and the "Engagement" pill reads the leaderboard endpoint.

- [ ] **Step 1: Add the leaderboard hook (only fetched data, always called — SWR dedupes)**

Find the Top Performers data block (near lines 90-96 on main):

```tsx
  // Top Performers + Top Links — fixed 30-day window (compact glance cards).
  const perfEnd = toISO(today);
  const perfStart = toISO(new Date(today.getTime() - 29 * 86400000));
  const { data: linksAnalyticsData, isLoading: topPerformersLoading } = useLinksAnalytics(perfStart, perfEnd);
  const topSubmitters: { employeeId: string; name: string; totalLinks: number; reportCount: number }[] =
    (linksAnalyticsData as any)?.data?.topSubmitters ?? [];
  const topPerformers = topSubmitters.slice(0, 3);
```

Replace with:

```tsx
  // Top Performers + Top Links — fixed 30-day window (compact glance cards).
  const perfEnd = toISO(today);
  const perfStart = toISO(new Date(today.getTime() - 29 * 86400000));
  const { data: linksAnalyticsData, isLoading: topPerformersLoading } = useLinksAnalytics(perfStart, perfEnd);
  const topSubmitters: { employeeId: string; name: string; totalLinks: number; reportCount: number }[] =
    (linksAnalyticsData as any)?.data?.topSubmitters ?? [];

  // Top Performers metric pill — independent, non-persisted.
  // Links & Reports re-sort the analytics topSubmitters; Engagement reads the leaderboard.
  const PERF_METRICS = [
    { key: "links", label: "Links" },
    { key: "reports", label: "Reports" },
    { key: "engagement", label: "Engagement" },
  ];
  const [perfMetric, setPerfMetric] = useState("links");
  const { data: leaderboardData } = useSWR(
    `/admin/reports/leaderboard?startDate=${perfStart}&endDate=${perfEnd}`,
    (url: string) => apiFetch<any>(url),
    { revalidateOnFocus: false, dedupingInterval: 300_000 }
  );
  const leaderboardRows: any[] = (leaderboardData as any)?.data ?? [];

  // Build the top-3 list for the selected metric. Each row is normalized to
  // { employeeId, name, primary (the big colored number), secondary (the grey badge) }.
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
    if (perfMetric === "reports") {
      return [...topSubmitters]
        .sort((a, b) => b.reportCount - a.reportCount)
        .slice(0, 3)
        .map((p) => ({
          employeeId: p.employeeId,
          name: p.name,
          primary: `${p.reportCount} report${p.reportCount !== 1 ? "s" : ""}`,
          secondary: `${p.totalLinks} links`,
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

> `useSWR` and `apiFetch` are already imported on main (the QuickAnnounceModal used them — verify the imports still exist after the CEO redesign; if `useSWR`/`apiFetch` are no longer imported on main's dashboard, add `import useSWR from "swr";` and `import { apiFetch } from "@/lib/api";`). **Task 3 Step 2 checks this.**

- [ ] **Step 2: Ensure `useSWR` and `apiFetch` are imported**

Run:
```bash
grep -n 'import useSWR' apps/internal/src/app/dashboard/page.tsx
grep -n 'apiFetch' apps/internal/src/app/dashboard/page.tsx | head -1
```
If either returns nothing, add to the import block:
```tsx
import useSWR from "swr";
import { apiFetch } from "@/lib/api";
```

- [ ] **Step 3: Add the pill group + rewrite the list to use the normalized shape**

Find the Top Performers card (near lines 525-562 on main). Replace the header + list body:

```tsx
        {/* Top Performers — left half */}
        <div className="lg:col-span-2 v3-card p-5 space-y-4 v3-card-lift">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-sage-soft flex items-center justify-center">
                <Trophy className="h-5 w-5 text-sage" />
              </div>
              <div>
                <p className="font-bold text-ink">Top Performers</p>
                <p className="text-xs text-ink-4">Last 30 days</p>
              </div>
            </div>
            <PillGroup>
              {PERF_METRICS.map((m) => (
                <Pill
                  key={m.key}
                  accent="sage"
                  active={perfMetric === m.key}
                  onClick={() => setPerfMetric(m.key)}
                >
                  {m.label}
                </Pill>
              ))}
            </PillGroup>
          </div>

          {topPerformersLoading ? (
            <div className="space-y-2 animate-pulse">
              {[0, 1, 2].map((i) => <div key={i} className="h-8 bg-muted rounded-lg" />)}
            </div>
          ) : topPerformers.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-sm text-ink-4">No data in the last 30 days</p>
            </div>
          ) : (
            <ul className="space-y-2">
              {topPerformers.map((p, i) => (
                <li key={p.employeeId} className="flex items-center gap-2">
                  <span className="text-xs font-bold text-ink-4 w-4 shrink-0">{i + 1}</span>
                  <Link
                    href={`/reports/${p.employeeId}`}
                    className="flex-1 min-w-0 text-xs font-semibold text-ink hover:underline truncate"
                  >
                    {p.name}
                  </Link>
                  <span className="text-[10px] text-ink-4 bg-ink/5 rounded-full px-2 py-0.5 shrink-0">
                    {p.secondary}
                  </span>
                  <span className="text-xs font-semibold text-sage shrink-0">{p.primary}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex justify-end">
            <Link href="/reports/leaderboard" className="flex items-center gap-1.5 text-xs font-semibold text-sage hover:underline">
              View all <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
```

> The static subtitle "· by links submitted" is removed from the header (the metric is now selectable). The engagement metric only has data once the leaderboard SWR resolves; while it's still loading the card falls back to the analytics-driven loading flag — acceptable because the leaderboard is a fast query and the empty state ("No data") is shown if it truly has none.

- [ ] **Step 4: Type-check**

Run:
```bash
npx tsc --noEmit -p apps/internal/tsconfig.json
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/internal/src/app/dashboard/page.tsx
git commit -m "feat(dashboard): Top Performers metric pills (Links/Reports/Engagement)"
```

---

## Task 4: Wire pills into Account Growth (window: 7d / 30d / 90d + platform)

**Files:**
- Modify: `apps/internal/src/app/dashboard/page.tsx`

The screenshot's "account growth must also have more filter." Add a **window** pill (re-fetches `useGrowthOverview(days)`) and a **platform** pill (client-side filter of the already-fetched accounts — no new fetch).

- [ ] **Step 1: Make the growth window a state-driven arg and derive platform options**

Find (near lines 78-88 on main):

```tsx
  // Account Growth + Top Movers — fixed 30-day window (the full picker lives on /accounts/growth)
  const { data: growthData, isLoading: growthLoading } = useGrowthOverview(30);
  const g = (growthData as any)?.data;
  const growthAccountCount: number = g?.accountCount ?? 0;
  const topMovers: TopMover[] = g?.topMovers ?? [];
  const sortedTopMovers = [...topMovers]
    .sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0))
    .slice(0, 5);
  const growthLive: number | undefined = g?.liveCount;
  const growthStale: number | undefined = g?.staleCount;
  const growthManual: number | undefined = g?.manualCount;
```

Replace with:

```tsx
  // Account Growth + Top Movers share a window pill (re-fetches) and a platform pill
  // (client-side filter of the same payload). Both independent, non-persisted.
  const GROWTH_WINDOWS = [
    { key: 7, label: "7d" },
    { key: 30, label: "30d" },
    { key: 90, label: "90d" },
  ];
  const [growthDays, setGrowthDays] = useState(30);
  const [growthPlatform, setGrowthPlatform] = useState("all"); // "all" | platform key
  const { data: growthData, isLoading: growthLoading } = useGrowthOverview(growthDays);
  const g = (growthData as any)?.data;
  const growthAccountCount: number = g?.accountCount ?? 0;
  const topMovers: TopMover[] = g?.topMovers ?? [];
  const topMoversByPlatform: Record<string, TopMover[]> = g?.topMoversByPlatform ?? {};

  // Platform options come from the payload's per-platform mover buckets (falls back to none).
  const growthPlatformOptions = Object.keys(topMoversByPlatform);

  // The mover list respects the platform pill: "all" uses combined topMovers,
  // a specific platform uses that bucket. Both are already abs(delta)-sorted server-side.
  const sortedTopMovers = (
    growthPlatform === "all" ? topMovers : (topMoversByPlatform[growthPlatform] ?? [])
  )
    .slice()
    .sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0))
    .slice(0, 5);

  const growthLive: number | undefined = g?.liveCount;
  const growthStale: number | undefined = g?.staleCount;
  const growthManual: number | undefined = g?.manualCount;
```

> **Platform total caveat (be honest in UI):** the growth payload gives combined `totalFollowers`/`totalDelta` and per-platform *movers*, but not a clean per-platform *total-followers* aggregate. So the Account Growth **headline number stays the combined total** regardless of platform pill; the platform pill only re-scopes the **Top Movers list** (Task 6). This avoids inventing a number the API doesn't return. If a per-platform headline is later wanted, that's a backend change and out of scope. **The Account Growth card's platform pill is therefore deferred to Top Movers** — see decision below.

**DECISION for Account Growth card:** apply only the **window pill** to the Account Growth card (headline + coverage counts are window-driven and honest). Do NOT put a platform pill on Account Growth (it would imply a per-platform follower total the API doesn't provide). The **platform pill lives on Top Movers** (Task 6), where it legitimately re-scopes the mover list. This keeps every number truthful.

- [ ] **Step 2: Add the window pill to the Account Growth card header**

Find the Account Growth card header (near lines 415-426 on main):

```tsx
        {/* Account Growth summary — left half */}
        <div className="lg:col-span-2 v3-card p-5 space-y-4 v3-card-lift">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-indigo-soft flex items-center justify-center">
                <Users className="h-5 w-5 text-indigo" />
              </div>
              <div>
                <p className="font-bold text-ink">Account Growth</p>
                <p className="text-xs text-ink-4">Last 30 days</p>
              </div>
            </div>
          </div>
```

Replace with (dynamic subtitle + window pills):

```tsx
        {/* Account Growth summary — left half */}
        <div className="lg:col-span-2 v3-card p-5 space-y-4 v3-card-lift">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-indigo-soft flex items-center justify-center">
                <Users className="h-5 w-5 text-indigo" />
              </div>
              <div>
                <p className="font-bold text-ink">Account Growth</p>
                <p className="text-xs text-ink-4">Last {growthDays} days</p>
              </div>
            </div>
            <PillGroup>
              {GROWTH_WINDOWS.map((w) => (
                <Pill
                  key={w.key}
                  accent="indigo"
                  active={growthDays === w.key}
                  onClick={() => setGrowthDays(w.key)}
                >
                  {w.label}
                </Pill>
              ))}
            </PillGroup>
          </div>
```

- [ ] **Step 3: Type-check**

Run:
```bash
npx tsc --noEmit -p apps/internal/tsconfig.json
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/internal/src/app/dashboard/page.tsx
git commit -m "feat(dashboard): Account Growth window pills (7d/30d/90d)"
```

---

## Task 5: Wire pills into Top Movers (platform: All + per-platform) + fix truncated names

**Files:**
- Modify: `apps/internal/src/app/dashboard/page.tsx`

Two things: the platform pill (uses `topMoversByPlatform` from Task 4's state), and the screenshot's truncated-names defect.

- [ ] **Step 1: Rewrite the Top Movers card header with platform pills**

Find the Top Movers card header (near lines 464-473 on main):

```tsx
        {/* Top Movers — right half */}
        <div className="lg:col-span-1 v3-card p-5 space-y-4 v3-card-lift">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-indigo-soft flex items-center justify-center">
              <Trophy className="h-5 w-5 text-indigo" />
            </div>
            <div>
              <p className="font-bold text-ink">Top Movers</p>
              <p className="text-xs text-ink-4">Biggest 30-day change</p>
            </div>
          </div>
```

Replace with (dynamic subtitle + platform pills; pills only render if the payload has per-platform buckets):

```tsx
        {/* Top Movers — right half */}
        <div className="lg:col-span-1 v3-card p-5 space-y-4 v3-card-lift">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-indigo-soft flex items-center justify-center">
              <Trophy className="h-5 w-5 text-indigo" />
            </div>
            <div>
              <p className="font-bold text-ink">Top Movers</p>
              <p className="text-xs text-ink-4">Biggest {growthDays}-day change</p>
            </div>
          </div>
          {growthPlatformOptions.length > 0 && (
            <PillGroup>
              <Pill accent="indigo" active={growthPlatform === "all"} onClick={() => setGrowthPlatform("all")}>
                All
              </Pill>
              {growthPlatformOptions.map((plat) => (
                <Pill
                  key={plat}
                  accent="indigo"
                  active={growthPlatform === plat}
                  onClick={() => setGrowthPlatform(plat)}
                >
                  {plat.charAt(0).toUpperCase() + plat.slice(1)}
                </Pill>
              ))}
            </PillGroup>
          )}
```

- [ ] **Step 2: Fix the truncated-names row layout**

Find the Top Movers list `<li>` (near lines 485-513 on main). The problem: rank + name + platform badge + external icon + delta all on ONE row in a 1/3-width card crushes the name. Fix: put the name on its own top line (full width, truncates gracefully), and rank/platform/delta/icon on a second line. Replace the `<ul>` block:

```tsx
          {growthLoading ? (
            <div className="space-y-2 animate-pulse">
              {[0, 1, 2].map((i) => <div key={i} className="h-8 bg-muted rounded-lg" />)}
            </div>
          ) : sortedTopMovers.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-sm text-ink-4">No movers yet</p>
            </div>
          ) : (
            <ul className="space-y-2.5">
              {sortedTopMovers.map((m, i) => {
                const safeUrl = httpUrlOrNull(m.profileUrl);
                return (
                  <li key={m.accountId} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs font-bold text-ink-4 w-4 shrink-0">{i + 1}</span>
                      <Link
                        href={`/accounts/${m.accountId}`}
                        className="flex-1 min-w-0 text-xs font-semibold text-ink hover:underline truncate"
                        title={m.displayName}
                      >
                        {m.displayName}
                      </Link>
                      {safeUrl && (
                        <a
                          href={safeUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          title="Open channel in a new tab"
                          aria-label={`Open ${m.displayName} channel`}
                          className="shrink-0 text-ink-4 hover:text-indigo transition-colors"
                        >
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                    <div className="flex items-center gap-2 pl-6">
                      <span className="text-[10px] text-ink-4 bg-ink/5 rounded-full px-2 py-0.5 shrink-0">{m.platform}</span>
                      <DeltaBadge delta={m.delta} deltaPct={m.deltaPct} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
```

> Now the name gets a full-width row and only truncates when genuinely too long (with a `title` tooltip showing the full name). The metadata drops to a second, indented line — no more "Bollywood R…".

- [ ] **Step 3: Type-check**

Run:
```bash
npx tsc --noEmit -p apps/internal/tsconfig.json
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/internal/src/app/dashboard/page.tsx
git commit -m "feat(dashboard): Top Movers platform pills + fix truncated account names"
```

---

## Task 6: Links Activity — add a platform-breakdown strip

**Files:**
- Modify: `apps/internal/src/app/dashboard/page.tsx`

The screenshot's "Links activity has great features … Add to these as well." The Links Activity card already has date-range pills + a bar chart. Add a small **platform breakdown** strip (from the analytics `platformBreakdown` already fetched by the Top Performers `useLinksAnalytics` call — reuse it, no new fetch).

- [ ] **Step 1: Expose platformBreakdown from the existing analytics data**

The `linksAnalyticsData` from Task 3 already contains `platformBreakdown`. Add a derived value near the other analytics derivations (after the `topSubmitters` line):

```tsx
  const linksPlatformBreakdown: { platform: string; count: number }[] =
    (linksAnalyticsData as any)?.data?.platformBreakdown ?? [];
```

> Note: `useLinksAnalytics(perfStart, perfEnd)` uses the fixed 30-day window (for Top Performers). The Links Activity card uses its OWN `linkStart`/`linkEnd` range. To avoid confusing the user by showing a 30-day breakdown under a 14-day chart, fetch a breakdown for the Links Activity range instead. **Decision:** add a dedicated call keyed to the Links Activity range:

```tsx
  const { data: linkActivityAnalytics } = useLinksAnalytics(linkStart, linkEnd);
  const linksPlatformBreakdown: { platform: string; count: number }[] =
    (linkActivityAnalytics as any)?.data?.platformBreakdown ?? [];
```

Use this second form (range-matched). `useLinksAnalytics` is already imported.

- [ ] **Step 2: Render the breakdown strip above the bar chart**

Find the Links Activity "Stat chips" block (near lines 328-353 on main) — insert the platform breakdown strip right AFTER the closing `</div>` of the stat chips and BEFORE the "Submission rate bar" block:

```tsx
          {/* Platform breakdown for the selected range */}
          {linksPlatformBreakdown.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {linksPlatformBreakdown
                .slice()
                .sort((a, b) => b.count - a.count)
                .map((p) => (
                  <span
                    key={p.platform}
                    className="inline-flex items-center gap-1.5 text-[11px] font-medium text-ink-3 bg-muted rounded-full px-2.5 py-1"
                  >
                    <span className="capitalize">{p.platform}</span>
                    <span className="font-num font-semibold text-ink">{fmtCompact(p.count)}</span>
                  </span>
                ))}
            </div>
          )}
```

- [ ] **Step 3: Type-check**

Run:
```bash
npx tsc --noEmit -p apps/internal/tsconfig.json
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/internal/src/app/dashboard/page.tsx
git commit -m "feat(dashboard): Links Activity platform-breakdown strip"
```

---

## Task 7: Full build + verification gate (MANDATORY — do not skip)

**Files:** none (verification)

- [ ] **Step 1: Full monorepo build**

Per CLAUDE.md, a single-app build can miss shared-import breakage. Run the full build:

```bash
cd /Users/tabish/Desktop/dashmani-platform
npm run build
```
Expected: all apps build with no errors. If `internal` OOMs locally (2GB-box symptom does not apply locally, but if it does), build just internal: `npm run build -w @dashmani/internal`.

- [ ] **Step 2: Start dev server and open the dashboard**

```bash
lsof -ti:3000,4000 | xargs kill -9 2>/dev/null; true
npm run dev
```
Wait for `internal` on :3000 and `api` on :4000. Log in (admin@digitalsukoon.com) and open `http://localhost:3000/dashboard`.

- [ ] **Step 3: Click through every pill on every card and confirm no crash**

Manually verify (this is the "no crashes/unexpected errors" gate the user demanded):

- **Top Links:** click YouTube → Instagram → Facebook. List changes; metric label updates ("by views" vs "by likes + comments"); a platform with no data shows "No {platform} links in the last 30 days" — never a blank crash.
- **Top Performers:** click Links → Reports → Engagement. List re-ranks; the big number + grey badge swap correctly; Engagement shows "N eng" and populates once the leaderboard loads.
- **Account Growth:** click 7d → 30d → 90d. Headline total + "Last N days" subtitle + live/stale/manual counts update (a fresh fetch each time).
- **Top Movers:** click All → each platform pill. List re-scopes; names are NOT truncated to "Bollywood R…" (full name on its own line, tooltip on hover); subtitle says "Biggest Nd change" matching the window.
- **Links Activity:** the new platform-breakdown chips appear and update when you change the 14d/30d/90d/custom range.

- [ ] **Step 4: Mobile check at 390px**

In browser devtools, set viewport to 390px wide. Confirm:
- No horizontal page scroll.
- Every pill group **wraps** to a new line instead of overflowing.
- Top Movers names still readable.

- [ ] **Step 5: Console check**

Open devtools console. Click through all pills again. Expected: **zero red errors** (no "cannot read property of undefined", no unhandled promise rejections). If any appear, the null-guard on that card's data is missing — fix before proceeding.

- [ ] **Step 6: Final commit (if any fixes were made in Steps 3-5)**

```bash
git add apps/internal/src/app/dashboard/page.tsx
git commit -m "fix(dashboard): verification-pass adjustments for card pills"
```

---

## Task 8: PR

**Files:** none

- [ ] **Step 1: Push and open PR**

```bash
git push -u origin feat/dashboard-card-pills
gh pr create --base main --title "feat(dashboard): filter pills on CEO glance cards + UI/UX fixes" --body "$(cat <<'EOF'
## Summary
Adds click-to-toggle filter pills to the four CEO-dashboard glance cards and fixes the UI defects in the reported screenshot. Frontend-only — reuses existing endpoints, no backend/DB/cron changes, no db:push.

- **Top Links:** platform pills (YouTube / Instagram / Facebook). YouTube ranks by views, IG/FB by likes+comments (backend already does this). Removes the "YouTube-only" limitation.
- **Top Performers:** metric pills (Links / Reports / Engagement) — no longer limited to link-submitters. Engagement reads the existing leaderboard endpoint.
- **Account Growth:** window pills (7d / 30d / 90d). Headline stays the honest combined total.
- **Top Movers:** platform pills (All + per-platform) + **fixed truncated account names** (name now gets its own row with a hover tooltip).
- **Links Activity:** added a platform-breakdown chip strip matched to the selected date range.
- All pill state is independent + non-persisted; every card keeps its loading/empty guards.

## Verification
- `tsc --noEmit` clean (internal)
- Full `npm run build` green (all apps)
- Live browser: every pill on every card clicked, zero console errors, 390px wrapping confirmed

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage (against the user's message):**
- ✅ "top movers have their names cut short" → Task 5 Step 2 (two-line row + tooltip).
- ✅ "top links must not represent just youtube" → Task 2 (platform pills).
- ✅ "top performers must also not be limited to only those who submit links" → Task 3 (metric pills incl. Reports + Engagement).
- ✅ "accounts growth must also have more filter" → Task 4 (window pills).
- ✅ "simple pills that can be clicked … without causing any sabotage or site issues/crashes/unexpected errors" → shared `<Pill>`, independent non-persisted state, every card retains guards, Task 7 crash-gate, frontend-only guardrails.
- ✅ "top movers, account growth, top links, top performers must be sensibly sized" → UI/UX decisions section (keep 2+1 rhythm; Top Movers row redesign).
- ✅ "Links activity … Add to these as well" → Task 6 (platform-breakdown strip).

**Placeholder scan:** No TBD/TODO/"handle edge cases" — every step has concrete code.

**Type consistency:** `topPerformers` normalized to `{employeeId,name,primary,secondary}` in Task 3 and consumed with those exact keys. `topLinksRows` typed with `views/likes/comments` in Task 2 and read with those keys. `topMoversByPlatform`/`growthPlatform`/`growthDays` defined in Task 4 and consumed in Tasks 4-5. `Pill`/`PillGroup` signatures match usage. `TopMover` type reused from the existing `use-growth` import.

**Known assumptions (flagged for the implementer):**
1. Import availability of `useSWR`/`apiFetch` on main's dashboard is checked at runtime (Task 3 Step 2) rather than assumed.
2. `top-links` IG/FB rows carrying `likes`/`comments` is inferred from `getTopLinksByPlatform` sorting by `likes+comments` — if the row shape omits them, Task 2's metric falls back to `fmtCompact(0)` which is safe; verify the actual row shape in Task 7 Step 3 and adjust the field names if needed.
3. Account Growth platform pill deliberately omitted (would imply a per-platform follower total the API doesn't return) — platform filtering lives on Top Movers where it's truthful.
