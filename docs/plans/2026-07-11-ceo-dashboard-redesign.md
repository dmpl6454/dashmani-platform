# CEO Dashboard Redesign (PR-B) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or subagent-driven-development) to implement this plan task-by-task.

**Goal:** Rebuild the internal portal dashboard ([apps/internal/src/app/dashboard/page.tsx](../../apps/internal/src/app/dashboard/page.tsx)) into a CEO-at-a-glance view: essentials visible top-to-bottom on scroll, low-signal cards demoted into a collapsible section, the in-your-face "Broadcast to All Employees" pill removed, and four high-signal blocks added — **Account Growth, Top Movers, Top Performers (employees), Top Links (best posts)** — all with honest data labels.

**Architecture:** **Frontend-only. No backend, no new hooks, no `db:push`.** Every data source already exists and is proven in production (see "Data sources" below). This PR is pure assembly + layout of existing SWR hooks into a new arrangement, with independent lazy-loading per block. `demote ≠ delete` — nothing the current dashboard shows is removed from the product; the demoted cards move into an in-place collapsible section and remain reachable.

**Tech Stack:** Next.js App Router (client component), SWR, Tailwind (existing `v3-card`/`ink`/`indigo`/`sage`/`terra`/`action` tokens), recharts, lucide-react. Match the existing dashboard's visual language exactly.

---

## Decisions already locked (from the 2026-07-10/11 brainstorming session)

| Decision | Choice |
|---|---|
| Layout | **Option 1 — "Command strip + bento"** (see layout sketch below) |
| Demoted cards | New Joiners, Published, Projects, Tasks Done, Present → **single collapsible "More metrics" section**, collapsed by default, expands in-place (stays on page) |
| Pending Approvals + new-joiner alert | **Keep prominent** (actionable blockers) — top of page, shown only when non-zero |
| Broadcast pill | **Removed entirely** — the top-right "Send Announcement" affordance in the header/top-nav is the honest home for it (VERIFY it exists before removing the pill — see Task 1) |
| New blocks | Account Growth, Top Movers, Top Performers, Top Links — **compact top-3/top-5 + "View all →" link** to the existing deep pages |
| Data honesty | **Calm honest labels** — LIVE/STALE/MANUAL freshness on growth, "IG: likes+comments (no views)" note, "since <date>" coverage where relevant. No fake 100%. |
| Loading | **Independent lazy loading** — each block has its own hook + skeleton; fast blocks paint immediately, heavier ones fill in |
| Data for review | Build/judge on **local dev DB** — panels will show honest empty-states (no real accounts seeded locally); that's expected and fine for judging layout |

## Layout sketch (Option 1)

```
Hello, <name>                                    [Send Announcement ↗ — already in top-nav]
Management Portal · <org one-liner>

┌─ Pending Approvals + new-joiner alert (ONLY if either > 0) ─────────────────┐  ← actionable, first
├─ LINKS ACTIVITY (kept, promoted, unchanged bento) ─────────────────────────┤
│   Today · Week · Month · Submitted-today + rate · 14/30/90d chart          │
├─ ACCOUNT GROWTH ───────────────────────┬─ TOP MOVERS ───────────────────────┤
│  Total followers + Δ (30d) + Δ%         │  ▲ top gainers / ▼ top decliners   │
│  "N live · M stale · K manual" label    │  (per-account Δ, top 5, View all →)│
├─ TOP PERFORMERS (employees) ───────────┬─ TOP LINKS (best posts) ───────────┤
│  top-3 by links (30d) + View all →      │  top-3 by views/eng + View all →   │
│                                         │  per-platform honest note           │
├─ ▸ More metrics (collapsed by default) ────────────────────────────────────┤
│    New Joiners · Published · Projects · Tasks Done · Present  (the old cards)│
└──────────────────────────────────────────────────────────────────────────────┘
```

## Data sources — ALL EXIST, no new backend

| Block | Hook (already in `apps/internal/src/lib/hooks/`) | Endpoint | Key fields |
|---|---|---|---|
| Links Activity (keep as-is) | `useOverviewStats` (`use-analytics.ts`) | `GET /analytics/overview` | `linksToday/Week/Month`, `submittedTodayCount`, `submissionRateToday`, `linksTrend` |
| Pending Approvals + new joiners (keep) | `useOverviewStats` | same | `pendingApprovals` (+ `pendingDocuments/ProfilePictures/LeaveRequests`), `pendingEmployees` |
| **Account Growth + Top Movers** | `useGrowthOverview(days)` (`use-growth.ts`) | `GET /admin/growth?days=30` | `totalFollowers`, `totalDelta`, `gainers`, `decliners`, `liveCount/staleCount/manualCount`, `liveFollowers/…`, `topMovers[]` (`{displayName, platform, delta, deltaPct, profileUrl}`), `topMoversByPlatform` |
| **Top Performers (employees)** | `useLinksAnalytics(start,end)` (`use-reports.ts`) → `topSubmitters` | `GET /admin/reports/links-analytics` | `topSubmitters[]` (`{employeeId, name, totalLinks, reportCount}`) — OR the richer `/admin/reports/leaderboard` if engagement ranking is wanted |
| **Top Links (best posts)** | `useInsightsSummary(start,end)` (`use-reports.ts`) | `GET /admin/reports/insights-summary` | `topLinks[]` (`{url, platform, employeeName, views, likes, comments, fetchedAt}`), `byPlatform[]`, `supportedPlatforms` |
| Demoted cards | `useOverviewStats` | same | `pendingEmployees`, `contentPublishedThisMonth`, `activeProjects`, `tasksCompletedThisMonth`, `presentToday` |

Pattern reference: [apps/internal/src/app/reports/leaderboard/page.tsx](../../apps/internal/src/app/reports/leaderboard/page.tsx) already fetches platform-leaderboards + coverage via SWR + `apiFetch` — copy its idioms. [apps/internal/src/app/accounts/growth/page.tsx](../../apps/internal/src/app/accounts/growth/page.tsx) already renders the Live/Stale/Manual SyncBadge + top-movers — **lift its label/badge components rather than reinventing.**

---

## Task 1: Verify the top-right "Send Announcement" affordance, then remove the Broadcast pill

**Files:** `apps/internal/src/app/dashboard/page.tsx`, `apps/internal/src/components/top-nav.tsx` (read only)

**Step 1** — Read `top-nav.tsx` and confirm there is an existing "Announcements" / "Send Announcement" control in the header (the login screenshot + current dashboard show an "Announcements" button top-right). If it opens the announce flow, the pill is redundant and safe to remove. If it ONLY links to history (not compose), then the `QuickAnnounceModal` compose path must be preserved somewhere before removing the pill — wire the header button to open `QuickAnnounceModal` instead of deleting the modal.
**Step 2** — Remove the full-width `Broadcast to All Employees` bento block (the `lg:col-span-3 ... bg-ink` card, ~lines 291–316 in the current file). **Keep the `QuickAnnounceModal` component + its `announceOpen` state** — just remove the big pill that triggers it, and ensure the header path can still open it.
**Step 3** — Verify build + click-through: the dashboard no longer shows the pill; announcing is still reachable from the top-right.
**Step 4** — Commit: `feat(dashboard): remove in-your-face Broadcast pill (keep announce in top-nav)`

## Task 2: Demote low-signal cards into a collapsible "More metrics" section

**Step 1** — Move New Joiners, Published, Projects, Tasks Done, Present out of the always-visible 11-card strip into a `<details>`-style (or `useState` toggle) collapsible section at the bottom, collapsed by default, labeled "More metrics (5)". Keep Links Today / Links/Month / Submitted-today in the promoted area (they're high-signal).
**Step 2** — Each demoted card keeps its existing `href` link (source-of-truth page). Expanding is in-place, no navigation.
**Step 3** — `prefers-reduced-motion` respected on the expand animation.
**Step 4** — Commit: `feat(dashboard): collapse low-signal cards into 'More metrics'`

## Task 3: Account Growth + Top Movers block

**Step 1** — Add a bento row: left = Account Growth (headline `totalFollowers` + 30d `totalDelta` + %, and the honest freshness line "N live · M stale · K manual" from `liveCount/staleCount/manualCount`), right = Top Movers (top 5 by abs delta from `topMovers[]`, ▲/▼ colored, each linking to its `profileUrl`). "View all →" links to `/accounts/growth`.
**Step 2** — Reuse the SyncBadge/label component from `accounts/growth/page.tsx` (don't reinvent). Independent SWR (`useGrowthOverview(30)`) with its own skeleton.
**Step 3** — Honest empty-state when no accounts / no snapshots (local dev DB will hit this) — "No follower data yet" not a broken chart.
**Step 4** — Commit: `feat(dashboard): Account Growth + Top Movers block (honest freshness labels)`

## Task 4: Top Performers + Top Links block

**Step 1** — Add a bento row: left = Top Performers (top 3 employees by `topSubmitters` links, 30d) + "View all →" to `/reports/leaderboard`; right = Top Links (top 3 from `useInsightsSummary().topLinks` by views, with the per-platform honest note — IG shows likes+comments, no views) + "View all →" to `/reports`.
**Step 2** — Independent SWR + skeletons. Honest empty-states.
**Step 3** — Commit: `feat(dashboard): Top Performers + Top Links block`

## Task 5: Verify (frontend acceptance bar)

**Step 1** — `npx tsc --noEmit -p apps/internal/tsconfig.json` clean.
**Step 2** — **Full `npm run build`** (all apps — a dashboard import could pull shared components caught only by the full build).
**Step 3** — Local browser click-through (dev DB): log in → dashboard shows the new layout, no Broadcast pill, "More metrics" collapses/expands, all four new blocks render with honest empty-states, no console errors on a fresh session. Screenshot each block.
**Step 4** — Confirm nothing regressed: the kept Links Activity bento still works; the header announce path still opens the modal.

---

## Non-goals / guardrails
- **No backend changes, no new hooks, no `db:push`.** If a needed field is genuinely missing from an existing hook, STOP and flag it — don't silently add a backend endpoint (that would change the PR's risk profile).
- **Demote ≠ delete** — every metric currently on the dashboard stays reachable.
- Don't touch the load-bearing incident fixes (daily-report submit, rbac asyncHandler, connection pool, getReportSummary groupBy).
- Match existing Tailwind tokens/card styles exactly — this should look native, not bolted on.
- Real numbers only where the data is real; honest empty-states/labels everywhere else (the whole point of the PR-A accuracy work feeding this).
