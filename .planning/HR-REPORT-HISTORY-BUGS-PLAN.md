# HR Report — History "—" bug + Mobile form distortion

**Created:** 2026-05-22
**Scope:** `apps/hr` frontend + one tiny additive field in `apps/api` (no DB, no schema, no migration).
**Sizing:** Small-Medium. ~2 files in API, ~2 files in HR frontend, ~80–150 lines total.
**Target executor:** Sonnet (medium thinking) — self-contained, recipe-style.

---

## 1. The two bugs (from user, 2026-05-22)

> "In the HR portal report history, why is it that people like (Kajal Yadav) see '—' in the report history even though she has selected a channel while submitting the report and updating the report, etc. Also the UI gets a bit distorted after links are added on mobile."

Confirmed via code inspection — both are real and reproducible.

### Bug A — Every history link renders as "—" (platform + account)

The screenshot of `https://hr.digitalsukoon.com/history` shows 10+ Instagram links, all with a "—" platform pill and no account name. **This is universal, not Kajal-specific.** Any user viewing `/history` sees this for every link of every report.

### Bug B — Form layout distorts on mobile after links are added

Screenshot of `/report` on mobile shows the "Submitted today (65)" panel rendering fine, but the form below it starts to break — the `Link #1 INSTAGRAM` row header and the inline chip cluster overflow the viewport. Worse as more links are pasted in.

---

## 2. Bug A — Root cause

### 2.1 What the API returns

[apps/api/src/services/daily-report.service.ts:22-37](../apps/api/src/services/daily-report.service.ts) — `formatReport()` returns each link as a **flat** object:

```ts
links: (report.links ?? []).map((link: any) => ({
  id: link.id,
  accountId: link.accountId,
  accountName: link.account?.displayName ?? "",     // flat
  platform: link.account?.platform?.name ?? ...,    // flat
  platformSlug: link.account?.platform?.slug ?? "", // flat
  url: link.url,
  ...
}))
```

There is **no `account` sub-object** on the link. Just `accountName`, `platform`, `platformSlug` at the top level. The `handle` field is **not exposed at all**.

### 2.2 What the history page reads

[apps/hr/src/app/history/page.tsx:60-68](../apps/hr/src/app/history/page.tsx) — `ReportCard` reads from a nested `account` that doesn't exist:

```tsx
const pc = platCfg(lk.account?.platform ?? "");   // ← undefined → fallback to "—"
{(lk.account?.platform ?? "—").toLowerCase()}     // ← prints "—"
{lk.account?.handle || lk.account?.name || "—"}   // ← prints "—"
```

So `lk.account?.X` is always `undefined`, and the `?? "—"` / `|| "—"` fallback wins for every link.

### 2.3 Why the `/report` "Submitted today" panel works

[apps/hr/src/app/report/page.tsx:136-142](../apps/hr/src/app/report/page.tsx) reads the **correct flat** fields plus a fallback to the assigned-accounts map:

```ts
const platform = (l.platformSlug || acc?.platformSlug || acc?.platform || "").toLowerCase();
const accountLabel = l.accountName || acc?.displayName || acc?.handle || "";
```

That confirms the data is fine in the API response — only `/history` is reading the wrong shape.

### 2.4 The fix (frontend-only, smallest possible)

Change [apps/hr/src/app/history/page.tsx:59-68](../apps/hr/src/app/history/page.tsx) to read the flat fields the API actually sends. **Also expose `handle`** from the API since `displayName` (currently mapped to `accountName`) is often blank or differs from the @handle users want to see.

#### 2.4.1 API change (tiny, additive, no breaks)

In [apps/api/src/services/daily-report.service.ts:22-37](../apps/api/src/services/daily-report.service.ts), add `accountHandle` next to `accountName`:

```ts
links: (report.links ?? []).map((link: any) => ({
  id: link.id,
  accountId: link.accountId,
  accountName: link.account?.displayName ?? "",
  accountHandle: link.account?.handle ?? "",        // ← NEW
  platform: link.account?.platform?.name ?? link.platform ?? "",
  platformSlug: link.account?.platform?.slug ?? "",
  ...
}))
```

This is purely additive — no existing consumer breaks. The `/report` panel and the link-history fix will both read it.

> ⚠️ Confirm no other call site of `formatReport` would be surprised by an extra field — there are six call sites (`submitDailyReport`, `getMyReports`, `getTodayReport`, `getReportById`, `getAllReports`) and adding a key is safe for all of them.

#### 2.4.2 History page fix

Replace the inner loop in `ReportCard` ([apps/hr/src/app/history/page.tsx:59-83](../apps/hr/src/app/history/page.tsx)) with:

```tsx
{links.map((lk: any, i: number) => {
  const platformSlug = (lk.platformSlug || lk.platform || "").toLowerCase();
  const accountLabel = lk.accountHandle || lk.accountName || "—";
  const pc = platCfg(platformSlug);
  return (
    <li key={lk.id ?? i} style={i < links.length - 1 ? { borderBottom: "1px solid rgba(26,26,26,0.05)" } : {}}>
      <div className="px-5 py-3 flex items-center gap-3">
        <span className={`h-5 px-2 rounded-full text-[10px] font-bold inline-flex items-center shrink-0 ${pc.bg} ${pc.text}`}>
          {platformSlug || "—"}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-[12.5px] font-semibold text-ink truncate">{accountLabel}</p>
          {lk.url && (
            <a href={lk.url} target="_blank" rel="noopener noreferrer"
              className="text-[11.5px] text-indigo font-medium hover:underline truncate flex items-center gap-1">
              {lk.url} <ExternalLink size={10} />
            </a>
          )}
        </div>
        {/* keep existing engagement block, but read flat fields */}
        {(lk.likes != null || lk.comments != null) && (
          <div className="flex gap-3 text-[10.5px] text-ink-4 font-medium shrink-0">
            {lk.likes != null && <span>{lk.likes} likes</span>}
            {lk.comments != null && <span>{lk.comments} comments</span>}
          </div>
        )}
      </div>
    </li>
  );
})}
```

Note: the engagement block was previously reading `lk.engagement.likes` / `lk.engagement.comments`. That's *also* wrong — `formatReport` exposes them as flat `likes`, `comments`, `shares`, `views`. Fix this in the same patch — it's the same class of bug.

### 2.5 Acceptance criteria for Bug A

1. Log in to HR portal locally → `/history` → every link shows a colored platform pill (e.g. "instagram" on pink) and a real account handle (e.g. `@bollywood_chronicle`).
2. Engagement counts (likes / comments) render when present.
3. No "—" placeholder appears on any link that has an assigned account (confirmed in DB via Prisma Studio — `report_links.accountId` is non-null).
4. Same on prod after deploy.

---

## 3. Bug B — Mobile form layout distortion

### 3.1 What's broken

At 375px viewport on the `/report` page, the following render badly:

| Element | Problem | File:line |
|---|---|---|
| Page header chips ("X live", "Y scheduled") | `flex items-start justify-between` with a left title block + right chip column; chips wrap and crowd the title | [report/page.tsx:399-426](../apps/hr/src/app/report/page.tsx) |
| Smart Paste header row | `<button>` trigger + `<select>` fallback-account in same flex row — at 375px the select overflows right edge | [report/page.tsx:454-483](../apps/hr/src/app/report/page.tsx) |
| Link card header | 5+ inline children on one row: `[index] [Link #N] [auto-matched/unmatched chip] [platform tag] [Scheduled toggle] [Trash]` — overflows horizontally | [report/page.tsx:555-593](../apps/hr/src/app/report/page.tsx) |
| Account select option text | `{handle} ({platform})` truncates against the right edge — visually fine but cramped | [report/page.tsx:617-619](../apps/hr/src/app/report/page.tsx) |
| Metrics row | Icon + "METRICS" label sits inline-left of the 2-col grid → label gets squeezed | [report/page.tsx:80-101](../apps/hr/src/app/report/page.tsx) |
| TodaySubmittedPanel meta row | `<span>platform · accountLabel · scheduled-pill</span>` in one flex line — wraps unevenly | [report/page.tsx:163-172](../apps/hr/src/app/report/page.tsx) |

### 3.2 Fixes (minimal, Tailwind-only — no new components)

Stay inside this one file ([apps/hr/src/app/report/page.tsx](../apps/hr/src/app/report/page.tsx)). No DOM restructure — only class changes.

#### Fix 3.2.1 — Page header
Wrap on mobile, side-by-side from `sm:` up:
```tsx
<div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
  {/* left block unchanged */}
  <div className="text-left sm:text-right space-y-1">
    {/* chips: allow wrap */}
    <div className="flex flex-wrap items-center gap-2 sm:justify-end">
      {/* ... existing chips ... */}
    </div>
    <p className="text-[10px] text-[#B0B0B0]">Max {MAX_LINKS_PER_ACCOUNT} per account</p>
  </div>
</div>
```

#### Fix 3.2.2 — Smart Paste header row
Stack the trigger button and the fallback-account on mobile:
```tsx
<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-2">
  {/* button unchanged */}
  {accounts.length > 0 && (
    <div className="flex items-center gap-2 w-full sm:w-auto">
      <label className="text-xs text-[#7A7A7A] shrink-0">Fallback account:</label>
      <select … className="border … rounded-lg px-3 py-1.5 text-xs … flex-1 sm:flex-none min-w-0" />
    </div>
  )}
</div>
```

#### Fix 3.2.3 — Link card header
Split into two rows on mobile: row 1 = `[index] [Link #N] [status chip]`; row 2 = `[Scheduled toggle] [Trash]`. Use `flex-wrap` so chips reflow:
```tsx
<div className="flex flex-wrap items-center justify-between gap-2">
  <div className="flex flex-wrap items-center gap-2 min-w-0">
    <span className="h-6 w-6 rounded-md bg-[#F7ECD5] … shrink-0">{i + 1}</span>
    <h3 className="font-medium text-[#1A1A1A] text-sm">Link #{i + 1}</h3>
    {/* status chips … */}
    {platform && !isUnmatched && (
      <span className="text-[10px] uppercase tracking-wider text-[#B0B0B0] font-medium">{platform}</span>
    )}
  </div>
  <div className="flex items-center gap-1 shrink-0">
    {/* Scheduled toggle + Trash unchanged */}
  </div>
</div>
```

#### Fix 3.2.4 — Metrics row
Drop the inline `<BarChart3>` + "Metrics" label on mobile, restore at `sm:`. The grid will then take the full row:
```tsx
<div className="pt-1">
  <div className="hidden sm:flex items-center gap-2 mb-1.5">
    <BarChart3 className="h-3.5 w-3.5 text-[#B0B0B0]" />
    <span className="text-[10px] text-[#B0B0B0] uppercase tracking-wider font-medium">Metrics</span>
  </div>
  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
    {/* metric inputs unchanged */}
  </div>
</div>
```

#### Fix 3.2.5 — TodaySubmittedPanel meta row
Allow wrap; tighten gap on mobile:
```tsx
<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5 text-[11px] text-[#7A7A7A]">
  {/* unchanged children, but parent now flex-wrap */}
</div>
```

Also let the panel header wrap on mobile so the "Last updated" timestamp doesn't get squeezed:
```tsx
<div className="flex flex-wrap items-center justify-between gap-2">
  {/* unchanged children */}
</div>
```

### 3.3 Acceptance criteria for Bug B

Tested at exactly **375px** width in Chrome DevTools mobile emulation:

1. `/report` page header: title and chips never overflow; chips wrap below the title cleanly.
2. Smart Paste: button row stacks above the fallback-account row on mobile; select doesn't overflow.
3. After adding 5 links via paste: each link card header reflows without horizontal scroll; Scheduled toggle and Trash stay aligned right.
4. Metrics inputs fit 2 per row on mobile, 5 per row from `sm:` up; "METRICS" label is hidden on mobile.
5. TodaySubmittedPanel: panel header wraps; per-item meta row wraps when content exceeds width.
6. **No horizontal scroll** anywhere on the page at 375px (`document.documentElement.scrollWidth === document.documentElement.clientWidth`).
7. Desktop (≥ 1024px) view is **visually unchanged** — every class change is mobile-first with `sm:` reverting to the old layout.

---

## 4. Implementation order (for the executor)

1. **API:** add `accountHandle` to `formatReport()` link mapping. Confirm `npm run build -w @dashmani/api` passes.
2. **History page:** swap nested-`account` reads → flat-field reads (+ fix the `engagement` sub-object bug). Confirm `npx tsc --noEmit -p apps/hr/tsconfig.json`.
3. **Report page mobile:** apply the five class-level fixes in §3.2. Test at 375px in DevTools.
4. **Full build:** `npm run build` (all apps) — auth and shared modules don't change, but run it to be safe.
5. **Local verify:** `npm run dev`, log in as any HR user, visit `/history` (link platform + handle render), then `/report` (mobile emu at 375px, no overflow).
6. **Commit + push** to a branch, open PR, merge after CI passes. Auto-deploys via GitHub Actions in ~3 min.
7. **No db:push, no seed re-run.** Zero schema changes.

---

## 5. Out of scope (explicitly do NOT do this)

- ❌ Don't redesign the link card. Class tweaks only.
- ❌ Don't change `formatReport`'s shape for existing fields. Only add `accountHandle`.
- ❌ Don't extract any of this into a new component file. Edit-in-place.
- ❌ Don't touch `submitDailyReport` — the submission flow is correct; only display was broken.
- ❌ Don't add a "fix" for `platform: lk.account?.platform?.name ?? link.platform`. The flat `link.platform` already gets returned and is the correct fallback path; the history fix consumes it directly.

---

## 6. Why Kajal showed up as the reporter

She didn't — every HR user sees "—" on every link in their own history. Her name appeared in the screenshot because she was the user who happened to flag it. The fix is universal; there is no per-user data corruption.

The user's screenshot also shows the **internal portal's** employee-reports view (the 65-link list at `hr.digitalsukoon.com`-style URL). If the same "—" appears in the internal portal's `/reports/[employeeId]` or `/reports` admin views, those pages may share the same nested-`account` consumer bug — **out of scope for this plan**, but worth a quick grep:

```bash
grep -rn "lk\.account\?\.\|link\.account\?\." apps/internal/src apps/hr/src
```

If any other call site reads `lk.account?.X`, file a follow-up. This plan only fixes `/history` on HR.

### 6.1 Confirmed additional sites (fix in same patch)

A grep across `apps/hr/src` + `apps/internal/src` for `lk.account?.` / `link.account?.` found these additional sites — they have the **same bug** and should be fixed in the same PR since they're trivial:

| File:line | Wrong read | Fix |
|---|---|---|
| [apps/hr/src/app/dashboard/page.tsx:198](../apps/hr/src/app/dashboard/page.tsx) | `lk.account?.platform \|\| lk.platform` | `lk.platformSlug \|\| lk.platform` |
| [apps/hr/src/app/dashboard/page.tsx:205](../apps/hr/src/app/dashboard/page.tsx) | `lk.account?.handle \|\| lk.account?.name \|\| lk.account?.displayName` | `lk.accountHandle \|\| lk.accountName` |

Skip [apps/internal/src/components/link-preview-card.tsx](../apps/internal/src/components/link-preview-card.tsx) — that component is shaped to accept *either* a flat `accountName` or a nested `account.name`. Its fallback chain already handles both. Out of scope.
