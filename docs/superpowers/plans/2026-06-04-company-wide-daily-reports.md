# Company-Wide Daily Reports (Written) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every employee (not just link-posters) a reliable written daily report they can submit/update, and a company-wide admin view to read them day-to-day — by reshaping the existing (admin-invisible) POA feature, without touching the load-bearing Link Report flow.

**Architecture:** Reuse the existing `DailyPOA` table and `/hr/poa` + `/admin/poa` endpoints (all already implemented). Slim the HR `/plan` form from 4 fields to 3 (What I did today → `tasks`, What I'll do tomorrow → `tomorrowPlan`, Notes → reuse the `blockers` column). Relabel it "Daily Report". Add ONE new endpoint for company-wide today-status, and ONE new admin page `/daily-reports` (placed next to "Accounts" in the sidebar) that lists today's written reports + a clear "Not submitted today" panel. No schema change, no `db:push`.

**Tech Stack:** Next.js App Router (apps/hr, apps/internal), Express + Prisma (apps/api), SWR, Tailwind, lucide-react, shared `@dashmani/shared` IST date utils.

**Hard safety constraints (do NOT violate):**
- Do NOT edit `apps/hr/src/app/report/page.tsx` or any Link Report validator/service. It is out of scope.
- Do NOT change `packages/db/prisma/schema.prisma`. No migration, no `db:push`.
- HR pages MUST `import { apiFetch } from "@/lib/api"` (reads `hrAccessToken`). Never a local helper.
- Internal pages MUST `import { apiFetch } from "@/lib/api"` (reads `accessToken`).
- "Today" on the backend uses `todayIST()`/`istMidnight()` from `@dashmani/shared`; on the frontend use local date-parts, never `toISOString().split("T")[0]`.

---

## File Structure

**Modify (HR portal — reshape form + relabel nav):**
- `apps/hr/src/app/plan/page.tsx` — 4 fields → 3; relabel "Daily Report"; Notes maps to `blockers`.
- `apps/hr/src/components/hr-sidebar.tsx:35` — label "Plan of Action" → "Daily Report".
- `apps/hr/src/components/top-nav.tsx:21` — label "POA" → "Daily Report".

**Modify (API — one new endpoint only):**
- `apps/api/src/routes/admin-features.routes.ts` — add `GET /admin/daily-reports/status` (today's submitters + non-submitters). Existing `/admin/poa` and `/hr/poa` are reused unchanged.

**Create (internal portal — the missing admin view):**
- `apps/internal/src/app/daily-reports/page.tsx` — company-wide written-reports page.
- `apps/internal/src/app/daily-reports/loading.tsx` — skeleton.
- `apps/internal/src/lib/hooks/use-daily-reports.ts` — SWR hooks.

**Modify (internal portal — nav entry):**
- `apps/internal/src/components/sidebar.tsx:22-23` — add `/daily-reports` entry right after "Accounts".

---

## Task 1: Reshape the HR Daily Report form (4 fields → 3)

**Files:**
- Modify: `apps/hr/src/app/plan/page.tsx`

Maps the form to your 3 fields. "What I did today" stays on `tasks`. "What I'll do tomorrow" stays on `tomorrowPlan`. "Notes" reuses the `blockers` column (achievements dropped from UI). The POST body already accepts all these fields — no API change. Keep today-only-editable, past read-only, date nav, history, upsert.

- [ ] **Step 1: Relabel the page title**

In `apps/hr/src/app/plan/page.tsx`, change the Topstrip (line ~97):

```tsx
<Topstrip title="Daily Report" sub="Log what you did today — visible to your admins" />
```

- [ ] **Step 2: Replace the achievements/blockers two-column grid with a single Notes card**

Find the block at lines ~172-205 (the `grid grid-cols-1 md:grid-cols-2 gap-4` containing Achievements + Blockers) and REPLACE the entire grid with a single Notes card. The Notes value is bound to the existing `blockers` state (we reuse it as Notes):

```tsx
            <div className="v3-card">
              <div className="px-5 h-12 flex items-center" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
                <span className="text-[13px] font-semibold text-ink">Notes</span>
              </div>
              <div className="p-5">
                <p className="text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Anything else worth noting</p>
                <textarea
                  value={blockers}
                  onChange={isReadOnly ? undefined : (e) => setBlockers(e.target.value)}
                  readOnly={isReadOnly}
                  rows={3}
                  placeholder={isReadOnly ? "Nothing recorded." : "Anything that doesn't fit above — issues, context, FYIs..."}
                  className={textareaClass(isReadOnly)}
                />
              </div>
            </div>
```

- [ ] **Step 3: Remove the now-unused `achievements` state and its references**

Delete line ~22 `const [achievements, setAchievements] = useState("");` and its uses:
- In `loadPOA` (lines ~42 and ~46): remove `setAchievements(res.data.achievements || "");` and `setAchievements("");`
- In `handleSave` body (line ~70): change the POST body to drop `achievements`:

```tsx
        body: JSON.stringify({ date: formatDate(date), tasks, tomorrowPlan, blockers }),
```

(The `tasks` required guard `if (!tasks.trim()) return;` and `disabled={saving || !tasks.trim()}` stay exactly as-is.)

- [ ] **Step 4: Update the "Today's Tasks" card label to "What I did today"**

At line ~153, change `{isToday ? "Today's Tasks *" : "Tasks"}` to:

```tsx
                  {isToday ? "What I did today *" : "What was done"}
```

And the sub-label at line ~158 `{isToday ? "What did you work on?" : "What was worked on"}` stays (already correct).

- [ ] **Step 5: Verify the HR app typechecks**

Run: `npx tsc --noEmit -p apps/hr/tsconfig.json`
Expected: PASS (no errors). If it complains about an unused `achievements`, ensure all references were removed in Step 3.

- [ ] **Step 6: Commit**

```bash
git add apps/hr/src/app/plan/page.tsx
git commit -m "feat(hr): reshape POA form into 3-field Daily Report (What I did / Tomorrow / Notes)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Relabel the HR nav entries (two files)

**Files:**
- Modify: `apps/hr/src/components/hr-sidebar.tsx:35`
- Modify: `apps/hr/src/components/top-nav.tsx:21`

Per CLAUDE.md's "two nav files" lesson, the HR portal has TWO nav definitions. Both reference `/plan` and must be relabeled.

- [ ] **Step 1: Relabel the sidebar entry**

In `apps/hr/src/components/hr-sidebar.tsx` line 35, change:

```tsx
  { href: "/plan",          label: "Daily Report",   icon: ClipboardList },
```

- [ ] **Step 2: Relabel the top-nav entry**

In `apps/hr/src/components/top-nav.tsx` line 21, change:

```tsx
  { href: "/plan", label: "Daily Report", icon: ClipboardList },
```

- [ ] **Step 3: Verify the HR app typechecks**

Run: `npx tsc --noEmit -p apps/hr/tsconfig.json`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/hr/src/components/hr-sidebar.tsx apps/hr/src/components/top-nav.tsx
git commit -m "feat(hr): relabel POA nav to 'Daily Report' in both nav files

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Add `GET /admin/daily-reports/status` endpoint (today's submitters + non-submitters)

**Files:**
- Modify: `apps/api/src/routes/admin-features.routes.ts` (add near the existing `/admin/poa` block, ~line 1101)

The existing `GET /admin/poa?date=` already returns the submitted reports with employee name/email. This new endpoint adds the OTHER half the admin page needs: the list of active employees who have NOT submitted a written report today. It mirrors the non-submitters pattern from `admin-reports.routes.ts:184-279` and uses the `employeeWhere` role convention so pure-admins aren't counted.

- [ ] **Step 1: Add the date util import**

At the top of `apps/api/src/routes/admin-features.routes.ts`, the file imports from `@dashmani/shared` on line 6. Extend that import to include the IST helpers:

```ts
import { generateOfferLetterSchema, safeString, todayIST, istMidnight } from "@dashmani/shared";
```

(Verify `todayIST` and `istMidnight` are exported from `@dashmani/shared` — they are used in `hr-features.routes.ts` POA handler, so they exist.)

- [ ] **Step 2: Add the endpoint after the `/admin/poa` handler**

Insert immediately after the `GET /admin/poa` route closes (after line ~1101, before `// ===== Internship Applications =====`):

```ts
// ===== Daily Report status (who submitted / who hasn't, today) =====

router.get("/admin/daily-reports/status", authenticate, requirePermission("employees", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { date } = req.query as { date?: string };
    const day = istMidnight(date || todayIST());

    // Active, non-pure-admin employees = the people expected to submit.
    const employees = await prisma.user.findMany({
      where: {
        status: "ACTIVE",
        deletedAt: null,
        roles: { some: { role: { name: { notIn: ["Super Admin", "Admin"] } } } },
      },
      select: { id: true, name: true, email: true },
      orderBy: { name: "asc" },
    });

    // Who submitted a written report for `day`.
    const submitted = await prisma.dailyPOA.findMany({
      where: { date: day },
      select: { employeeId: true },
    });
    const submittedIds = new Set(submitted.map((s) => s.employeeId));

    const nonSubmitters = employees.filter((e) => !submittedIds.has(e.id));

    return success(res, {
      date: req.query.date || todayIST(),
      totalEmployees: employees.length,
      submittedCount: employees.length - nonSubmitters.length,
      nonSubmitters,
    });
  } catch (err) { next(err); }
});
```

- [ ] **Step 3: Verify the API typechecks**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json`
Expected: PASS. If `todayIST`/`istMidnight` aren't found, check the export in `packages/shared/src/utils/date.ts` and the barrel `packages/shared/src/index.ts`.

- [ ] **Step 4: Smoke-test the endpoint locally (if dev servers are running)**

Run (replace TOKEN with a valid admin accessToken from localStorage):
```bash
curl -s "http://localhost:4000/v1/admin/daily-reports/status" -H "Authorization: Bearer TOKEN" | head -c 400
```
Expected: `{"success":true,"data":{"date":"...","totalEmployees":N,"submittedCount":M,"nonSubmitters":[...]}}`. If dev servers aren't running, skip — Task 7's build is the gate.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/admin-features.routes.ts
git commit -m "feat(api): GET /admin/daily-reports/status — today's submitters + non-submitters

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Add the internal SWR hooks

**Files:**
- Create: `apps/internal/src/lib/hooks/use-daily-reports.ts`

Two hooks: one for the submitted reports (existing `/admin/poa`), one for the today-status (new endpoint). `apiFetch` returns the full envelope, so the fetcher returns it and pages read `.data`.

- [ ] **Step 1: Create the hooks file**

```ts
import useSWR from "swr";
import { apiFetch } from "@/lib/api";

/** Submitted written daily reports for a given date (default: today). */
export function useDailyReports(date?: string, employeeId?: string) {
  const q = new URLSearchParams();
  if (date) q.set("date", date);
  if (employeeId) q.set("employeeId", employeeId);
  const key = `/admin/poa?${q.toString()}`;
  return useSWR(key, (url) => apiFetch(url), {
    revalidateOnFocus: false,
    dedupingInterval: 30_000,
  });
}

/** Today's submission status: who submitted, who hasn't. */
export function useDailyReportStatus(date?: string) {
  const q = new URLSearchParams();
  if (date) q.set("date", date);
  const key = `/admin/daily-reports/status?${q.toString()}`;
  return useSWR(key, (url) => apiFetch(url), {
    revalidateOnFocus: false,
    dedupingInterval: 30_000,
  });
}
```

- [ ] **Step 2: Verify the internal app typechecks**

Run: `npx tsc --noEmit -p apps/internal/tsconfig.json`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/internal/src/lib/hooks/use-daily-reports.ts
git commit -m "feat(internal): SWR hooks for admin daily-reports view

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Build the admin Daily Reports page

**Files:**
- Create: `apps/internal/src/app/daily-reports/page.tsx`
- Create: `apps/internal/src/app/daily-reports/loading.tsx`

A company-wide page defaulting to today. Top: a clearly-labelled "Not submitted today" panel with a count. Below: a card per submitting employee showing What I did / Tomorrow / Notes. Reuses the shared `RangePills` date picker pattern but for a SINGLE day we expose a simple date input + Today button (range pills are span-based; daily reports are per-day, so a single-date selector is the honest control). An employee filter dropdown reuses `useEmployees`.

Note on field mapping: the API returns the raw `DailyPOA` row, so `tasks` = What I did, `tomorrowPlan` = Tomorrow, `blockers` = Notes.

- [ ] **Step 1: Create `loading.tsx`**

```tsx
export default function Loading() {
  return (
    <div className="space-y-5 animate-pulse">
      <div className="h-8 w-56 bg-rule rounded-xl" />
      <div className="h-24 bg-rule rounded-2xl" />
      <div className="space-y-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-32 bg-rule rounded-2xl" />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `page.tsx`**

```tsx
"use client";
import { useState, useMemo } from "react";
import { ClipboardList, CalendarDays, CheckCircle2, AlertTriangle, Filter } from "lucide-react";
import { useDailyReports, useDailyReportStatus } from "@/lib/hooks/use-daily-reports";
import { useEmployees } from "@/lib/hooks/use-employees";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { UserAvatar } from "@/components/user-avatar";

// Local-date (IST for users in India) — never toISOString, which is UTC.
function todayLocalISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function displayDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function fmtTime(v: string | null | undefined): string {
  if (!v) return "";
  return new Date(v).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

export default function DailyReportsPage() {
  usePageTitle("Daily Reports");
  const [date, setDate] = useState(todayLocalISO());
  const [employeeId, setEmployeeId] = useState("");

  const isToday = date === todayLocalISO();

  const { data: reportsEnv, isLoading: reportsLoading } = useDailyReports(date, employeeId || undefined);
  const { data: statusEnv } = useDailyReportStatus(date);
  const { data: empEnv } = useEmployees({ limit: 500 });

  const reports = (reportsEnv as any)?.data ?? [];
  const status = (statusEnv as any)?.data;
  const employees = (empEnv as any)?.data ?? [];

  const nonSubmitters = status?.nonSubmitters ?? [];
  const submittedCount = status?.submittedCount ?? 0;
  const totalEmployees = status?.totalEmployees ?? 0;

  const sortedReports = useMemo(
    () => [...reports].sort((a: any, b: any) => (b.updatedAt || b.date).localeCompare(a.updatedAt || a.date)),
    [reports],
  );

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <span className="h-9 w-9 rounded-xl bg-[#FFF3C4] flex items-center justify-center">
          <ClipboardList className="h-5 w-5 text-[#1A1A1A]" />
        </span>
        <div>
          <h1 className="text-2xl font-bold text-[#1A1A1A]">Daily Reports</h1>
          <p className="text-sm text-[#7A7A7A]">Written work updates from all employees — {displayDate(date)}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-2xl border border-[#F0EAD8] p-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-[#7A7A7A]" />
          <input
            type="date"
            value={date}
            max={todayLocalISO()}
            onChange={(e) => setDate(e.target.value)}
            className="h-9 rounded-lg border border-[#E8E0D0] bg-[#FEFCF8] text-sm px-2.5 focus:outline-none focus:ring-2 focus:ring-[#F5D547]"
          />
          {!isToday && (
            <button
              onClick={() => setDate(todayLocalISO())}
              className="h-9 px-3 rounded-lg text-xs font-semibold text-[#1A1A1A] border border-[#E8E0D0] hover:border-[#1A1A1A]/30"
            >
              Today
            </button>
          )}
        </div>
        <span className="h-5 w-px bg-[#E8E0D0]" />
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-[#7A7A7A]" />
          <select
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
            className="h-9 rounded-lg border border-[#E8E0D0] bg-[#FEFCF8] text-sm px-2.5 focus:outline-none focus:ring-2 focus:ring-[#F5D547] min-w-[180px]"
          >
            <option value="">All employees</option>
            {employees.map((e: any) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Submission status banner (only meaningful for "all employees" view) */}
      {!employeeId && status && (
        <div className={`rounded-2xl border p-4 ${
          nonSubmitters.length === 0
            ? "bg-green-50 border-green-200"
            : "bg-amber-50 border-amber-200"
        }`}>
          <div className="flex items-center gap-2 mb-2">
            {nonSubmitters.length === 0 ? (
              <><CheckCircle2 className="h-5 w-5 text-green-600" /><span className="font-semibold text-green-800">Everyone has submitted {isToday ? "today" : "on this day"} ✅</span></>
            ) : (
              <><AlertTriangle className="h-5 w-5 text-amber-600" /><span className="font-semibold text-amber-800">{nonSubmitters.length} of {totalEmployees} {nonSubmitters.length === 1 ? "employee hasn't" : "employees haven't"} submitted {isToday ? "today" : "on this day"}</span></>
            )}
          </div>
          {nonSubmitters.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {nonSubmitters.map((e: any) => (
                <span key={e.id} className="inline-flex items-center gap-1.5 bg-white border border-amber-200 rounded-full px-2.5 py-1 text-xs text-[#7A4A00]">
                  <UserAvatar name={e.name} size={16} />
                  {e.name}
                </span>
              ))}
            </div>
          )}
          <p className="text-[11px] text-[#7A7A7A] mt-2">
            {submittedCount} submitted • counts active employees only (excludes pure-admin accounts).
          </p>
        </div>
      )}

      {/* Submitted reports */}
      {reportsLoading ? (
        <div className="bg-white rounded-2xl border border-[#F0EAD8] p-10 flex justify-center">
          <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-[#1A1A1A]" />
        </div>
      ) : sortedReports.length === 0 ? (
        <div className="bg-white rounded-2xl border border-[#F0EAD8] p-10 text-center text-[#7A7A7A]">
          <ClipboardList className="h-8 w-8 mx-auto mb-2 opacity-40" />
          No daily reports {employeeId ? "from this employee " : ""}for {displayDate(date)} yet.
        </div>
      ) : (
        <div className="space-y-3">
          {sortedReports.map((r: any) => (
            <div key={r.id} className="bg-white rounded-2xl border border-[#F0EAD8] p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <UserAvatar name={r.employee?.name ?? "—"} size={32} />
                  <div>
                    <p className="text-sm font-semibold text-[#1A1A1A]">{r.employee?.name ?? "Unknown"}</p>
                    <p className="text-[11px] text-[#B0B0B0]">{r.employee?.email}</p>
                  </div>
                </div>
                <span className="text-[11px] text-[#B0B0B0]">{fmtTime(r.updatedAt)}</span>
              </div>

              <div>
                <p className="text-[10.5px] font-bold text-[#B0B0B0] uppercase tracking-wider mb-0.5">What they did</p>
                <p className="text-sm text-[#1A1A1A] whitespace-pre-wrap">{r.tasks || "—"}</p>
              </div>

              {r.tomorrowPlan && (
                <div>
                  <p className="text-[10.5px] font-bold text-[#B0B0B0] uppercase tracking-wider mb-0.5">Tomorrow's plan</p>
                  <p className="text-sm text-[#4A4A4A] whitespace-pre-wrap">{r.tomorrowPlan}</p>
                </div>
              )}

              {r.blockers && (
                <div>
                  <p className="text-[10.5px] font-bold text-[#B0B0B0] uppercase tracking-wider mb-0.5">Notes</p>
                  <p className="text-sm text-[#4A4A4A] italic whitespace-pre-wrap">{r.blockers}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify UserAvatar accepts a `size` prop**

Run: `grep -n "size" apps/internal/src/components/user-avatar.tsx | head -3`
Expected: a `size` prop exists. If it does NOT, remove the `size={...}` props from the page (the component will use its default). Adjust before building.

- [ ] **Step 4: Verify the internal app typechecks**

Run: `npx tsc --noEmit -p apps/internal/tsconfig.json`
Expected: PASS. Fix any prop mismatches (esp. `UserAvatar`).

- [ ] **Step 5: Commit**

```bash
git add apps/internal/src/app/daily-reports/page.tsx apps/internal/src/app/daily-reports/loading.tsx
git commit -m "feat(internal): admin Daily Reports page — today's written reports + non-submitters

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Add the sidebar nav entry (next to Accounts)

**Files:**
- Modify: `apps/internal/src/components/sidebar.tsx` (after line 22, the "Accounts" entry)

User asked for it next to "Assign accounts". The closest existing nav item is "Accounts" (line 22). Place "Daily Reports" immediately after it. Reuse an already-imported icon to avoid touching the import list — `ClipboardList` is NOT currently imported; `FileText` IS (used by Reports). To keep it visually distinct from "Reports" yet avoid a new import, use `CheckSquare` (already imported) — but that's used by Tasks/Approvals. Cleanest: add `ClipboardList` to the existing lucide import on lines 5-11.

- [ ] **Step 1: Add `ClipboardList` to the lucide import**

In `apps/internal/src/components/sidebar.tsx`, the import block is lines 5-11. Add `ClipboardList` to it (e.g. append to line 9's list):

```tsx
  Bug, Sparkles, Laptop, GraduationCap, AlertCircle, Settings, LayoutGrid, ClipboardList,
```

- [ ] **Step 2: Insert the nav entry after "Accounts"**

After line 22 (`{ href: "/accounts", ... }`), insert:

```tsx
  { href: "/daily-reports", label: "Daily Reports",    icon: ClipboardList,   group: null },
```

- [ ] **Step 3: Verify the internal app typechecks**

Run: `npx tsc --noEmit -p apps/internal/tsconfig.json`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/internal/src/components/sidebar.tsx
git commit -m "feat(internal): add 'Daily Reports' to sidebar next to Accounts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Full verification (the gate)

**Files:** none (verification only)

Per CLAUDE.md: a full `npm run build` (all apps) is the real gate — shared/auth imports only surface there. Do NOT run `npm run build` while dev servers are running (it poisons the live `.next` cache — see the "build-over-dev" incident); stop dev servers first or rely on per-app `tsc` + a clean build.

- [ ] **Step 1: Typecheck all three touched apps**

Run:
```bash
npx tsc --noEmit -p apps/hr/tsconfig.json && \
npx tsc --noEmit -p apps/internal/tsconfig.json && \
npx tsc --noEmit -p apps/api/tsconfig.json
```
Expected: all PASS, no output.

- [ ] **Step 2: Full build (stop dev servers first)**

Run:
```bash
npm run build
```
Expected: all apps build successfully. If `apps/internal` fails on `ClipboardList` or `UserAvatar` props, fix per Task 5 Step 3 / Task 6 Step 1.

- [ ] **Step 3: Manual functional check (local dev)**

Start dev (`npm run dev`), then:
1. HR portal `/plan` (now "Daily Report"): submit with "What I did today" filled → green "saved" toast. Reload → values persist. Edit + save again → updates (upsert). Navigate to a past date → read-only. ✅
2. Internal portal `/daily-reports`: the report you just submitted appears under today, showing What/Tomorrow/Notes. The employee filter narrows to one person. The non-submitters panel shows a count and names; if you're the only employee and you submitted, it shows the green "Everyone has submitted" state. ✅
3. Confirm the **Link Report** flow (`/hr/report`) still submits exactly as before (you did NOT touch it). ✅

- [ ] **Step 4: Confirm no schema drift / no db:push needed**

Run: `git status packages/db/prisma/schema.prisma`
Expected: NOT modified (clean). Confirms no `db:push` on Linode.

- [ ] **Step 5: Final commit / push prep**

No code commit here. The branch `feat/company-wide-daily-reports` now holds the spec (Task 0) + Tasks 1-6. Ready for PR per CLAUDE.md deploy cycle.

---

## Self-Review

**Spec coverage:**
- 3-field written report (What I did / Tomorrow / Notes) → Task 1. ✅
- Separate from Link Report, link form untouched → enforced as hard constraint; Task 1-6 touch zero Link Report files. ✅
- Reuse POA table, Notes→`blockers`, no schema change → Task 1 + Task 7 Step 4. ✅
- Admins/super-admins only → existing `employees.view` gate on `/admin/poa` + new endpoint uses same gate (Task 3). ✅
- Admin view accessible next to Accounts → Task 6. ✅
- Non-submitters panel, understandable → Task 3 (endpoint) + Task 5 (clear count + names + green all-clear state). ✅
- Submit/update works → Task 1 keeps the existing upsert; Task 7 Step 3 verifies. ✅

**Placeholder scan:** No TBD/TODO; all steps have concrete code/commands. ✅

**Type consistency:** Hook names `useDailyReports`/`useDailyReportStatus` (Task 4) match their imports/usage in Task 5. Endpoint path `/admin/daily-reports/status` matches between Task 3 and Task 4. Field mapping (`tasks`/`tomorrowPlan`/`blockers`) consistent across Tasks 1, 3, 5. ✅

**Risk flagged inline:** `UserAvatar size` prop (Task 5 Step 3) and `ClipboardList` import (Task 6 Step 1) are the two spots most likely to need a small adjustment; both have explicit verify steps.
