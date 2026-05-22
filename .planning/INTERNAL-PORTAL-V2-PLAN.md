# Internal Admin Portal — v2 Fix Plan (Post Production Test Remediation)

> **⚠️ SUPERSEDED 2026-05-22.** All P0/P1 items in this plan have shipped or been explicitly deferred. The current source of truth is [`PORTAL-TEST-FINAL-V2-PLAN.md`](PORTAL-TEST-FINAL-V2-PLAN.md) — see its §0 reconciliation block. Code-level audit on 2026-05-22 confirmed:
>
> - ✅ Wave A (P0 security): AI preview sandbox, default credentials env-driven, input sanitization (`safeString` + `sanitizeAccountHandle`) — all shipped
> - ✅ Wave B (P1 core): analytics perm seed, AI employee dropdown, forgot-password, salary-slips/holidays API, missing endpoints, refresh-loop guard, crashing pages — all shipped
> - ✅ Wave C (P2 UX): status labels via `formatStatus()`, page titles via `usePageTitle()`, fake login stats removed, profile view-mode, workload columns, login copy, RBAC sidebar gating, employee form fields — all shipped
> - ⏸ F-TOKEN-STORAGE (TC-110, A-4): explicitly deferred XL per user decision 2026-05-21
> - ⏸ #26 "Keep me signed in" dead checkbox: P3, dormant UI (no security risk)
> - ⏸ HR password strength enforcement: P2, display-only meter — needs submit-time gate
>
> Do not action items from the waves below without first checking against the §0 block of `PORTAL-TEST-FINAL-V2-PLAN.md`. Several items here ("self-approval", "employee count mismatch", "UTM in account names") were already fixed by Wave A/B work — re-implementing them would be regression.
>
> This file is kept for historical context only.

---

**Source:** PORTAL-TEST-FINAL-V2-PLAN.md (215 manual test cases from production)
**Date compiled:** 2026-05-16
**Scope:** `apps/internal` + `apps/api` (internal/admin endpoints only)
**Predecessor:** internal-portal-plan.md (Phases 1–13 + Waves 7–9 all complete)

This plan addresses every internal-portal issue surfaced in the production test that was **not** fixed by previous waves. Issues already resolved in Waves 1–9 are marked ✅ and cross-referenced.

---

## 0. Already-fixed (do not re-open)

These TCs from the test sheet are resolved by prior waves:

| TC | Issue | Fix wave |
|---|---|---|
| TC-003a (reports/[id] crash) | `React.use(params)` error | Wave 8 — commit dad9b5f |
| TC-029 / TC-202 | No delete button for employees | Wave 8 — DELETE /admin/users/:id + UI button |
| TC-014 / TC-017 | Offer letters + contracts sidebar merge | Nav restructure done |
| TC-018 / TC-127 (HR forgot pw) | Forgot Password — HR portal | Separate HR plan |
| TC-124 / TC-201 | Avatar fallback initials | Resolved in Wave 8 cleanup |
| TC-123 | Dashboard "Review" button 404 | Fixed in pending route mount (Phase 1) |
| TC-126 | HR dashboard tiles 404 | HR portal scope |

---

## 1. Severity snapshot (internal portal only)

| Sev | Count | Key themes |
|---|---|---|
| **P0** | 5 | XSS in AI preview, localStorage token storage, default hardcoded creds, input sanitization, AI preview open-in-new-tab |
| **P1** | 18 | Analytics 403 (seed bug), AI employee dropdown wrong endpoint, salary slips 500, forgot password, status-label crashes, 8+ missing/broken API endpoints |
| **P2** | 27 | Fake login stats, page titles blank, profile edit-only mode, workload columns, status labels, form affordance, empty states, SWR polling, nav restructure |
| **P3** | 7 | Login copy, chat scroll, avatar edge cases, greeting TZ |

---

## 2. Fix waves

### Wave A — P0 Security (ship first, one PR per item)

---

#### A-1 — F-AI-PREVIEW-SANDBOX (TC-112, TC-113)

**Test cases:** TC-112 "AI-generated docs in unsafe preview — XSS risk", TC-113 "Opening AI doc in new tab runs content without safety checks"

**Root cause:** `apps/internal/src/app/ai-assistant/page.tsx` renders AI-generated HTML using `dangerouslySetInnerHTML` without sanitization. The "open in new tab" path also does this.

**Fix:**
1. Install `dompurify` and `@types/dompurify` in `apps/internal`.
2. Replace every `dangerouslySetInnerHTML={{ __html: generatedHtml }}` with:
   ```tsx
   dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(generatedHtml) }}
   ```
3. For the "open in new tab" flow: write the sanitized HTML into a `Blob`, create an object URL, open that — never pass raw `generatedHtml` to `window.open`.
4. Add a `sandbox="allow-same-origin"` attribute to any `<iframe>` used for AI preview rendering.

**Files:**
- `apps/internal/src/app/ai-assistant/page.tsx` — sanitize before render + before new-tab open
- `package.json` in `apps/internal` — add `dompurify`

**Verification:** Submit `<script>alert(1)</script>` as AI content → confirm no alert fires, script tag stripped.

---

#### A-2 — F-DEFAULT-CREDENTIALS (TC-108, TC-157)

**Test cases:** TC-108 "Default admin/client passwords hardcoded in source", TC-157 "admin@digitalsukoon.com / Admin@123456 is fully functional in production"

**Root cause:** `packages/db/prisma/seed.ts` hardcodes `Admin@123456` as the admin password and `admin@digitalsukoon.com` as the login. This is publicly visible in source control.

**Fix:**
1. In `packages/db/prisma/seed.ts`, replace the hardcoded password with an env-driven value:
   ```typescript
   const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? (() => { throw new Error("SEED_ADMIN_PASSWORD env var required"); })();
   ```
2. Add `SEED_ADMIN_PASSWORD` to `.env.example` with a note that it's required for seeding.
3. Remove the hardcoded credential comment from the seed file.
4. **Operational step (production):** Change the production admin password via the portal settings or a one-off DB update. Document this in the deployment runbook — not in source.

**Files:**
- `packages/db/prisma/seed.ts` — env-driven password
- `.env.example` — add `SEED_ADMIN_PASSWORD=` entry

**Verification:** Run `npm run db:seed` without `SEED_ADMIN_PASSWORD` → error thrown. Set env var → seed succeeds.

---

#### A-3 — F-INPUT-SANITIZATION (TC-200)

**Test cases:** TC-200 "Backend accepts `<script>` in Name field and returns 201"

**Root cause:** API create routes accept string fields without stripping HTML/script content. The `Name` field (and others like descriptions) are stored as-is.

**Fix:**
1. Add a `sanitizeString` Zod transformer in `packages/shared/src/validators/`:
   ```typescript
   export const safeString = z.string().transform(s => s.replace(/<[^>]*>/g, "").trim());
   ```
2. Apply `safeString` instead of `z.string()` to all name, description, title, and free-text fields in every shared validator (employee, task, project, team, account, client, content, job listing, announcement validators).
3. The API picks up these validators at request-time since `packages/shared` is imported in route handlers.

**Files:**
- `packages/shared/src/validators/` — all relevant validators; add + apply `safeString`
- `apps/api/src/routes/` — verify routes use shared validators (no inline z.string() on text fields)

**Verification:** POST `{ "name": "<script>alert(1)</script>" }` to `/employees` → response body contains plain-text name with tags stripped; status 201.

---

#### A-4 — F-TOKEN-STORAGE (TC-110)

**Test cases:** TC-110 "Login tokens stored in localStorage"

**Root cause:** `apps/internal/src/lib/auth.ts` (or `api.ts`) reads/writes the JWT to `localStorage`. This is vulnerable to XSS token theft.

**Fix:**
1. Move to httpOnly secure cookies:
   - API login endpoint sets `Set-Cookie: token=<jwt>; HttpOnly; Secure; SameSite=Strict; Path=/`
   - API adds a CSRF-safe approach (e.g., double-submit cookie for mutations).
2. Alternatively (minimal change for now): move to `sessionStorage` (XSS can still read it, but at least no persistence across tabs). **True fix is cookies.**
3. Remove all `localStorage.getItem("token")` and `localStorage.setItem("token", ...)` calls from the internal portal; replace with cookie reads via the API client (cookies are sent automatically by the browser).

**Note:** This is the most invasive change (touches auth flow across all portals). Coordinate with the auth consolidation work (F-AUTH-CONSOLIDATE). For now, scope to internal portal only.

**Files:**
- `apps/api/src/routes/auth.routes.ts` — set httpOnly cookie on login response
- `apps/api/src/middleware/auth.ts` — read token from cookie if Authorization header absent
- `apps/internal/src/lib/auth.ts` — remove localStorage token reads/writes
- `apps/internal/src/lib/api.ts` — remove manual Authorization header injection (cookie sent automatically)

**Verification:** Log in → open DevTools → Application → Local Storage → no `token` key. Network tab → cookie set with `HttpOnly` flag.

---

### Wave B — P1 Broken core features

---

#### B-1 — F-ANALYTICS-PERM (TC-080, TC-153, TC-165)

**Test cases:** All analytics show 0 / 403 "No permission: view on analytics"

**Root cause:** `packages/db/prisma/seed.ts` seeds Super Admin and Admin roles with these resources:
```
Super Admin: ["employees","teams","tasks","accounts","reports","attendance","roles","settings","clients","content","messages","billing"]
Admin: ["employees","teams","tasks","accounts","reports","attendance","clients","content","messages"]
```
Neither includes `"analytics"`. The analytics routes check `requirePermission("analytics","view")` and return 403.

**Fix:**
1. Add `"analytics"` to both the Super Admin and Admin resource lists in `packages/db/prisma/seed.ts`.
2. Run `npm run db:seed` (upsert — safe to re-run).

**Files:**
- `packages/db/prisma/seed.ts` — add analytics permission to Super Admin + Admin

**Verification:** After reseed, navigate to `/analytics` → graphs load with real data. Dashboard overview stats no longer show 0.

---

#### B-2 — F-AI-EMPLOYEE-DROPDOWN (TC-061, TC-063, TC-065, TC-081, TC-154, TC-163)

**Test cases:** All AI Assistant document tabs (Offer Letter, Appointment Letter, Employment Contract) have empty employee dropdowns. Root cause confirmed: calls `/admin/employees` which returns 404.

**Root cause:** `apps/internal/src/app/ai-assistant/page.tsx` line 30:
```typescript
useSWR("/admin/employees", (url: string) => apiFetch<any>(url))
```
The correct endpoint is `/employees` (mounted in `admin-reports.routes.ts` as GET /admin/employees/… — but the list endpoint is at `/employees`, not `/admin/employees`).

**Fix:**
Change line 30 from `/admin/employees` to `/employees`.

**Files:**
- `apps/internal/src/app/ai-assistant/page.tsx:30` — one-line change

**Verification:** Open `/ai-assistant` → Offer Letter tab → employee dropdown shows real employee names.

---

#### B-3 — F-FORGOT-PASSWORD (TC-018, TC-191 for client, internal)

**Test cases:** TC-018 "Forgot Password doesn't work" (internal portal)

**Root cause:** The internal portal login page has no "Forgot password?" link. The `auth.routes.ts` may or may not have a reset endpoint — needs verification.

**Fix — Part 1 (check if API endpoint exists):**
Check `apps/api/src/routes/auth.routes.ts` for `POST /auth/forgot-password` and `POST /auth/reset-password`. If missing, implement:
```
POST /auth/forgot-password   body: { email }  → generates reset token, sends email
POST /auth/reset-password    body: { token, newPassword }  → validates token, updates password
```

**Fix — Part 2 (frontend):**
1. Add `ForgotPasswordModal` to `apps/internal/src/app/login/page.tsx`:
   - "Forgot password?" link below the sign-in button
   - Modal: email field → "Send Reset Link" → POST `/auth/forgot-password` → success message
2. Add `/reset-password` page that accepts `?token=...` query param → shows new password form → POST `/auth/reset-password`.
3. Add `/reset-password` to public routes list in `apps/internal/src/app/layout.tsx`.

**Files:**
- `apps/api/src/routes/auth.routes.ts` — add reset endpoints (if missing)
- `apps/api/src/services/auth.service.ts` — add `forgotPassword()` and `resetPassword()` methods
- `apps/internal/src/app/login/page.tsx` — add forgot password link + modal
- `apps/internal/src/app/reset-password/page.tsx` — new page
- `apps/internal/src/app/layout.tsx` — add `/reset-password` to public routes

**Verification:** Click "Forgot password?" → enter email → receive reset email → follow link → set new password → log in with new password.

---

#### B-4 — F-SALARY-SLIPS-API (TC-013, TC-052, TC-152)

**Test cases:** "Salary slips not visible", "Does not work whatsoever", "Salary Slips API returns 500"

**Root cause:** The salary slips API route returns 500. This needs investigation. The service and route exist in `admin-features.routes.ts`. The 500 is likely a Prisma query error on a missing relation or incorrect field reference.

**Fix:**
1. Check `apps/api/src/services/salary-slip.service.ts` for any relations/fields that might be missing from schema or improperly queried.
2. Wrap the service call in a try/catch in the route and log the actual error.
3. Fix the underlying query error (likely a missing include relation or schema mismatch after db:push operations).
4. Test locally: GET `/admin/salary-slips` → confirm 200 with array.

**Files:**
- `apps/api/src/services/salary-slip.service.ts` — fix query
- `apps/api/src/routes/admin-features.routes.ts` — add error logging to salary slip routes

**Verification:** GET `/admin/salary-slips` returns 200 with data (or empty array). No 500.

---

#### B-5 — F-HOLIDAYS-API (TC-054, TC-055, TC-151)

**Test cases:** "Doesn't display public holidays", "Cannot add new holidays", "Holidays API returns 500"

**Root cause:** GET `/admin/holidays` returns 500. Same class of issue as salary slips.

**Fix:**
1. Check `apps/api/src/services/holiday.service.ts` and the holidays route in `admin-features.routes.ts`.
2. Fix the Prisma query causing the 500 (likely a bad include or missing field).
3. Verify POST (create holiday) also works.

**Files:**
- `apps/api/src/services/holiday.service.ts`
- `apps/api/src/routes/admin-features.routes.ts` — holidays section

**Verification:** GET `/admin/holidays` returns 200. POST creates holiday. UI displays holidays correctly.

---

#### B-6 — F-MISSING-ADMIN-ENDPOINTS (TC-146, TC-147, TC-148, TC-149, TC-150, TC-159)

**Test cases:** Attendance 404, Approvals 404, Workload 404, Admin Clients 404, Leaderboard 404

**Investigation needed:** These endpoints are confirmed 404 in production testing. But from code analysis, the routes *exist* in route files. The likely issue is that the production API URL or route mounting is different, OR these routes exist but under a different path than the frontend expects.

**Fix checklist per endpoint:**

| Frontend expects | Route file | Action needed |
|---|---|---|
| `GET /attendance` | `attendance.routes.ts` — confirmed exists | Check frontend hook URL |
| `GET /approvals` | `admin-features.routes.ts` — check | Verify exact path |
| `GET /workload` | Likely `admin-reports.routes.ts` | Find or create |
| `GET /admin/clients` | `client.routes.ts` — check | Find exact admin client list path |
| `GET /leaderboard` | `admin-reports.routes.ts` — leaderboard confirmed working | Check frontend hook URL |

**For each frontend page, audit the SWR hook URL against the actual mounted route:**
1. `apps/internal/src/app/attendance/page.tsx` — what SWR key does it use?
2. `apps/internal/src/app/approvals/page.tsx` — what SWR key?
3. `apps/internal/src/app/workload/page.tsx` — what SWR key?
4. `apps/internal/src/app/clients/page.tsx` — what SWR key?
5. `apps/internal/src/app/reports/leaderboard/page.tsx` — what SWR key?

For any mismatches: fix the frontend SWR hook URL to match the actual API path. If a route genuinely doesn't exist, create the minimal route + service.

**Files (TBD after audit):**
- Relevant `apps/internal/src/lib/hooks/use-*.ts` files — fix endpoint URLs
- Possibly: `apps/api/src/routes/` — add missing routes

---

#### B-7 — F-CRASHING-PAGES (TC-003, TC-031, TC-119)

**Test cases:**
- TC-003 "View All Reports crashes" — already fixed (Wave 8, commit dad9b5f)
- TC-031 "View All in Performance section crashes"
- TC-119 "HR salary slips page crashes when loading" — HR scope, skip for now

**Fix (TC-031):**
1. Navigate to `/employees/[id]/performance` — identify what causes the crash.
2. Likely a missing null-check on data returned from the API, or a similar `React.use(params)` issue.
3. Add proper null safety and loading state.

**Files:**
- `apps/internal/src/app/employees/[id]/performance/page.tsx`

---

#### B-8 — F-REFRESH-LOOP (TC-111)

**Test cases:** TC-111 "Session-expire + failed-refresh → endless retry loop / page crash"

**Root cause:** When the refresh token call fails, the API client likely retries indefinitely.

**Fix:**
1. In `apps/internal/src/lib/api.ts`, the refresh-token retry logic should:
   - Cap retries at 1 (try once, fail gracefully)
   - On final failure, call `clearAuthState()` and redirect to `/login`
2. Add a `isRefreshing` guard flag to prevent concurrent refresh calls.

**Files:**
- `apps/internal/src/lib/api.ts` — cap retry, redirect on final failure
- `apps/internal/src/lib/auth.ts` — `clearAuthState()` if not already present

---

#### B-9 — F-DEAD-LINKS (TC-123)

**Test cases:** TC-123 "Review button for pending employees → 404" — likely fixed in Phase 1 (route mounting). Verify first.

If still broken: Check the pending employees page and what URL the "Review" button links to.

---

### Wave C — P2 UX / Consistency

---

#### C-1 — F-STATUS-LABELS (TC-118, TC-136, TC-204, TC-220 — internal portal subset)

**Test cases:**
- TC-118 "`PENDING_APPROVAL` status not formatted" (salary slips)
- TC-136 "Job type labels `FULL_TIME`, `PART_TIME` shown underscored" (jobs)
- TC-204 "Bug reports filter shows `IN_PROGRESS`" (confirmed — raw)
- TC-220 "`UPPER_SNAKE_CASE` status values shown across all portals"

**Root cause:** No shared status formatter exists. Each page either handles it ad-hoc or not at all.

**Fix:**
1. Create `packages/shared/src/utils/status.ts`:
   ```typescript
   export function formatStatus(value: string): string {
     return value
       .split("_")
       .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
       .join(" ");
   }
   ```
2. Apply `formatStatus()` to every raw status display in the internal portal:
   - `apps/internal/src/app/salary-slips/page.tsx` — replace `.replace("_", " ")` with `formatStatus()`
   - `apps/internal/src/app/jobs/page.tsx` — job type + application status labels
   - `apps/internal/src/app/bug-reports/page.tsx` — filter labels + table
   - `apps/internal/src/app/complaints/page.tsx` — replace existing `.replace("_", " ")`
   - `apps/internal/src/app/internships/page.tsx` — status badges
   - `apps/internal/src/app/ai-assistant/page.tsx:369` — `{slip.status}` → `{formatStatus(slip.status)}`
   - Any other page with raw `{item.status}` renders

**Files:**
- `packages/shared/src/utils/status.ts` — new file
- All status-rendering pages in `apps/internal/src/app/`

---

#### C-2 — F-PAGE-TITLES (TC-085, TC-161)

**Test cases:** TC-085, TC-161 "Every page has empty browser tab title"

**Root cause:** All internal portal pages use `"use client"` — client components can't export Next.js `metadata`. The root `layout.tsx` has a default title but individual pages don't set it.

**Fix:**
Since pages are client components, use `document.title` in `useEffect` for each page, OR convert page shells to server components wrapping client sub-components.

**Simpler fix — root layout default + per-page `useEffect`:**
1. In `apps/internal/src/app/layout.tsx`, set a fallback `<title>Dashmani Portal</title>` in the `<head>`.
2. Create a `usePageTitle(title: string)` hook:
   ```typescript
   export function usePageTitle(title: string) {
     useEffect(() => { document.title = `${title} — Dashmani Portal`; }, [title]);
   }
   ```
3. Call `usePageTitle("Dashboard")`, `usePageTitle("Employees")` etc. at the top of each page component.

**Files:**
- `apps/internal/src/app/layout.tsx` — add default title to head
- `apps/internal/src/lib/hooks/use-page-title.ts` — new hook
- Every page.tsx in `apps/internal/src/app/` — add `usePageTitle("...")` call (bulk change)

---

#### C-3 — F-FAKE-STATS (TC-155, TC-172)

**Test cases:** TC-155, TC-172 "Login page right-side panel shows fake stats (24 Active, 8 Pending, 142 Tasks, 36 Projects, 12 posts scheduled, 85% Efficiency)"

**Root cause:** `apps/internal/src/app/login/page.tsx` contains hardcoded decorative stat cards in the right panel.

**Fix:**
Replace the hardcoded stat values with static decorative text, a background illustration, or the company logo/branding — remove all fake numeric stats that imply real data. The panel should be decorative only (e.g., a brand quote, a logo, or an abstract background).

**Files:**
- `apps/internal/src/app/login/page.tsx` — lines 127–168, replace fake stat cards

---

#### C-4 — F-PROFILE-VIEW-MODE (TC-084, TC-144)

**Test cases:** TC-084 "Profile page opens directly in edit mode (no read-only view)", TC-144 "Profile & Edit tab always in edit mode"

**Root cause:** `apps/internal/src/app/employees/[id]/page.tsx` opens with the `EmployeeForm` (edit form) visible by default in the Profile tab, even though there's an `isEditingProfile` state.

**Fix:**
1. Add a read-only view (similar to `InfoField` grids already used for submitted data) that displays employee info — name, email, phone, designation, department, salary — as static text.
2. Show an "Edit" button that switches to the `EmployeeForm`.
3. Default state: `isEditingProfile = false` showing read-only view.

**Files:**
- `apps/internal/src/app/employees/[id]/page.tsx` — profile tab read/edit mode switch

---

#### C-5 — F-WORKLOAD-COLUMNS (TC-095, TC-143, TC-166)

**Test cases:** "Critical and High column headers render empty when value is 0"

**Root cause:** `apps/internal/src/app/workload/page.tsx` lines 52–61 render badges only when count > 0; empty cell if 0.

**Fix:**
Replace the conditional render with always-show-value:
```tsx
// Before:
{task.critical > 0 && <Badge>{task.critical}</Badge>}

// After:
<span className="text-sm text-gray-500">{task.critical || "—"}</span>
```

**Files:**
- `apps/internal/src/app/workload/page.tsx` — lines 52-61, always render cell value

---

#### C-6 — F-SALARY-SLIPS-DUPLICATE-SELECTOR (TC-087, TC-164)

**Test cases:** "Month selection appears twice (tabs + dropdown)", "month selector duplicated on page"

**Root cause:** `apps/internal/src/app/salary-slips/page.tsx` has two month selectors — one for the bulk generation flow and one for filtering the list. They're both visible simultaneously.

**Fix:**
1. Keep only the filter month selector for the list view.
2. Move the bulk generation month picker inside the bulk generation modal/dialog — only visible when generating.
3. Fix the hardcoded `new Date(2024, i)` → `new Date(new Date().getFullYear(), i)` so month names use the current year.

**Files:**
- `apps/internal/src/app/salary-slips/page.tsx` — restructure month selectors, fix year

---

#### C-7 — F-LOGIN-COPY (TC-093, TC-171)

**Test cases:** "Hardcoded placeholder `you@digitalsukoon.com` (multi-tenant unfriendly)"

**Fix:**
Change the email input placeholder from `you@digitalsukoon.com` to a generic `Enter your email address`.

**Files:**
- `apps/internal/src/app/login/page.tsx` — email input placeholder

---

#### C-8 — F-FORM-AFFORDANCE (TC-086, TC-162)

**Test cases:** "Add Employee form: no placeholders, no required-field markers, missing Job Title/Department/Start Date/Manager"

**Root cause:** The `EmployeeForm` component is minimal — only Name, Email, Password, Phone, Roles. Missing: Job Title, Department, Start Date, Manager.

**Fix:**
1. Add missing fields to `apps/internal/src/components/employee-form.tsx`:
   - Job Title (text input, required, placeholder: "e.g. Social Media Manager")
   - Department (select from org units, required)
   - Start Date (date input, required)
   - Manager (employee select, optional)
2. Add `required` markers (asterisk) visually on all required fields.
3. Add placeholder text to existing Name, Email, Phone fields.
4. Wire the new fields to the POST `/employees` body.
5. Ensure the shared validator in `packages/shared` accepts and validates these fields.

**Files:**
- `apps/internal/src/components/employee-form.tsx` — add fields + required markers + placeholders
- `packages/shared/src/validators/employee.validator.ts` — extend schema if needed
- `apps/api/src/routes/employee.routes.ts` or `admin-features.routes.ts` — accept new fields

---

#### C-9 — F-NAV-CORRECTNESS (TC-083)

**Test cases:** "View button goes to `/employees/:id/performance`; breadcrumb says 'Employees / Reports' but URL says `/performance`"

**Fix:**
1. In `apps/internal/src/app/employees/page.tsx`, change the "View" button href from `/employees/:id/performance` to `/employees/:id`.
2. Fix the breadcrumb on the performance page to correctly read "Employees / [Name] / Performance".

**Files:**
- `apps/internal/src/app/employees/page.tsx` — fix View link href
- `apps/internal/src/app/employees/[id]/performance/page.tsx` — fix breadcrumb

---

#### C-10 — F-EMPTY-STATES (TC-141, TC-167, TC-206, TC-207)

**Test cases:**
- TC-141 / TC-167 "Projects empty state is just a blank white area" — from code analysis, this is already fixed (shows FolderOpen icon + message). **Verify in production.**
- TC-206 "Empty kanban shows no helper text or add-a-task prompt" — from code analysis, columns show "No tasks". Add a CTA button.
- TC-207 "Teams: 4 stat cards still show 0 in empty state" — expected behavior (they are real counts of 0). Verify test expectation.

**Fix (TC-206):**
In `apps/internal/src/app/tasks/page.tsx`, in the empty column state, add a "+ Add Task" button that links to `/tasks/new` or opens a quick-add form.

**Files:**
- `apps/internal/src/app/tasks/page.tsx` — add CTA to empty columns

---

#### C-11 — F-SWR-POLLING (TC-131, TC-133, TC-156)

**Test cases:**
- TC-131 "Sidebar reloads overview stats on every page change"
- TC-133 "Jobs page polls every 30s even when tab is backgrounded"
- TC-156 "Dashboard page never reaches idle — constant SWR polling"

**Fix:**
1. For sidebar stats: add `{ revalidateOnFocus: false, dedupingInterval: 60000 }` to the `useOverviewStats()` SWR hook.
2. For jobs page polling: add `{ revalidateOnFocus: false }` to the jobs SWR hook, or remove the `refreshInterval` if present.
3. For dashboard: check for any `refreshInterval` in dashboard hooks and increase or remove.

**Files:**
- `apps/internal/src/lib/hooks/use-overview-stats.ts` — SWR options
- `apps/internal/src/lib/hooks/use-jobs.ts` or similar — remove polling
- `apps/internal/src/app/dashboard/page.tsx` — SWR options check

---

#### C-12 — F-ERROR-VISIBILITY (TC-114, TC-168, TC-176)

**Test cases:**
- TC-114 "Role-load failure shows silent empty dropdown"
- TC-168 "Holidays UI silently swallows 500, shows 'No holidays for 2026'"
- TC-176 "Frontend silently swallows API errors — shows 'No data' instead of error message"

**Fix:**
1. Every SWR hook must expose its `error` value.
2. In affected pages, add an error branch:
   ```tsx
   if (isError) return <PageError message="Failed to load data. Please refresh or contact support." />;
   ```
3. The `<PageError>` component already exists in `apps/client/src/components/portal-shared.tsx` — port it to `apps/internal/src/components/` as a shared component.

**Files:**
- `apps/internal/src/components/page-error.tsx` — new (ported from client portal)
- `apps/internal/src/app/holidays/page.tsx` — add error branch
- `apps/internal/src/app/salary-slips/page.tsx` — add error branch
- `apps/internal/src/app/workload/page.tsx` — add error branch
- `apps/internal/src/app/complaints/page.tsx` — add error branch
- Any page with silent `isError` ignore

---

#### C-13 — F-DESTRUCTIVE-CONFIRM (TC-121)

**Test cases:** TC-121 "Extra hours Approve/Reject fire with no confirmation dialog"

**Fix:**
Add a confirm dialog (or use `window.confirm()` as a quick fix) before firing Approve/Reject on extra hours buttons.

**Files:**
- `apps/internal/src/app/employees/[id]/page.tsx` or the extra hours component — add confirm before action

---

#### C-14 — F-AVATAR-FALLBACK (TC-124, TC-201) — Verify if already fixed

**Test cases:** "Avatar fallback initials don't show when image fails", "Shows `<` for non-alphanumeric names"

**Root cause (if not fixed):** The `Avatar` component's initials logic may use `name.charAt(0)` without filtering for alphanumeric first characters.

**Fix:**
```typescript
function getInitials(name: string): string {
  const letters = name.match(/[A-Za-z]/g);
  return letters ? letters[0].toUpperCase() : "?";
}
```

**Files:**
- Shared `Avatar` component (likely `apps/internal/src/components/` or `packages/ui/src/`)

---

#### C-15 — F-INPUT-VALIDATION (TC-007, TC-038, TC-059, TC-135)

**Test cases:**
- TC-007 "POA accepts future dates" — validation needed
- TC-038 "Calendar field unresponsive when creating content"
- TC-059 "No input validation — strings in number fields (Job Vacancy AI form)"
- TC-135 "Incentive form accepts month 0 or 13"

**Fix per item:**
1. **POA (TC-007):** In the POA form, add `max={new Date().toISOString().split("T")[0]}` to the date input; server-side: validate `date <= today` in the POA validator.
2. **Content calendar (TC-038):** Investigate why date picker is unresponsive; likely a z-index or controlled input issue.
3. **AI form number fields (TC-059):** Add `type="number"` and `min` constraints to vacancy count / numeric fields in the AI assistant form.
4. **Incentive month (TC-135):** Add `min="1" max="12"` to the month input; server-side: validate range in incentive validator.

**Files:**
- `apps/internal/src/app/ai-assistant/page.tsx` — number field constraints
- Incentive form component — month range constraint
- POA form component — max date
- `packages/shared/src/validators/` — server-side validation for each

---

#### C-16 — F-RBAC-SIDEBAR (TC-008)

**Test cases:** TC-008 "Sidebar shows Offer Letters, Joining date, My contract, HR policies for employee role — inappropriate"

**Root cause:** Sidebar items are not gated by role. These are HR-managed items that employees shouldn't see in the admin portal.

**Fix:**
In `apps/internal/src/components/sidebar.tsx`, gate the display of role-sensitive items using the auth context (user's roles):
```tsx
const isAdmin = roles.some(r => ["Admin","Super Admin"].includes(r.name));
// Only show Offer Letters, Devices, Internships etc. to admin+ roles
```

**Files:**
- `apps/internal/src/components/sidebar.tsx` — role-based item visibility
- `apps/internal/src/lib/auth.ts` — ensure roles are available in auth context

---

#### C-17 — F-DATE-DRIFT (TC-117)

**Test cases:** TC-117 "Hardcoded year (2024) in month name generation"

**Fix:**
In `apps/internal/src/app/salary-slips/page.tsx`, replace:
```typescript
new Date(2024, i).toLocaleString("default", { month: "long" })
```
with:
```typescript
new Date(new Date().getFullYear(), i).toLocaleString("default", { month: "long" })
```
(This is already covered in C-6 above — dedup.)

---

#### C-18 — F-CLIENT-TZ (TC-097, TC-173)

**Test cases:** "Time-of-day greeting may be wrong for non-server-TZ users"

**Root cause:** If the greeting ("Good morning/afternoon/evening") is determined server-side, it uses server timezone. Should use client's local time.

**Fix:**
Ensure the greeting is calculated client-side in a `useEffect` using `new Date()` (client local time). If currently SSR, move to a client component with `useEffect`.

**Files:**
- `apps/internal/src/app/dashboard/page.tsx` — greeting calculation

---

#### C-19 — F-CSS-SCROLL (TC-019)

**Test cases:** TC-019 "No scroll bar present"

**Fix:**
In `apps/internal/src/app/globals.css`, ensure:
```css
body { overflow-y: auto; }
/* or if a scrollbar-hide utility is being applied: */
:root { scrollbar-width: thin; }
```

**Files:**
- `apps/internal/src/app/globals.css`

---

#### C-20 — F-BANNER-STATE (TC-096, TC-181)

**Test cases:** "ACTION REQUIRED banner — does it clear after report submission?"

**Fix:**
1. The banner in HR dashboard (and potentially internal) should check today's report state.
2. Fetch `GET /reports?employeeId=me&date=today` — if a report exists for today, hide the banner.
3. Banner should re-check after a report is submitted.

**Files:**
- `apps/internal/src/app/dashboard/page.tsx` — banner state logic (if present here)

---

### Wave D — P3 Polish

#### D-1 — F-CHAT-SCROLL (TC-142)
AI Chat doesn't auto-scroll to latest message.
- In `apps/internal/src/app/ai-assistant/page.tsx`, add `useEffect` to scroll the chat container to bottom when messages change.
- `messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })` after each message update.

#### D-2 — F-A11Y-LABELS (TC-137, TC-138, TC-139)
- TC-137: Add `alt` text to all employee avatar `<img>` tags.
- TC-138: Add `aria-label` to the AI assistant employee dropdown.
- TC-139: Add `aria-label="Close"` to all modal X buttons.

#### D-3 — F-LOGIN-SHAKE (TC-140)
Failed login shake animation never plays.
- In `apps/internal/src/app/login/page.tsx`, verify the CSS animation class for shake is actually applied on error.

#### D-4 — F-LEADERBOARD-MATH (TC-004a, TC-048)
Leaderboard ranking not aligned with streaks/links — math is skewed.
- Review `apps/api/src/services/leaderboard.service.ts` scoring algorithm and validate with test data.

---

## 3. Execution order

```
Wave A (P0 Security) — must ship first:
  A-1: AI Preview Sandbox
  A-2: Default Credentials (seed)
  A-3: Input Sanitization
  A-4: Token Storage → httpOnly cookies (most complex, can be last in Wave A)

Wave B (P1 Core features):
  B-1: Analytics permission seed fix  ← quickest, do first in B
  B-2: AI employee dropdown URL fix   ← one-line fix
  B-3: Forgot password
  B-4: Salary slips API 500 fix
  B-5: Holidays API 500 fix
  B-6: Missing endpoint audit + fixes
  B-7: Crashing pages
  B-8: Refresh loop

Wave C (P2 UX):
  C-1: Status labels (shared formatter)
  C-2: Page titles
  C-3: Login fake stats removal
  C-4: Profile view/edit mode
  C-5: Workload columns
  C-6: Salary slips dedup month selector
  C-7: Login placeholder copy
  C-8: Add employee form fields + affordance
  C-9: Nav link correctness
  C-10: Empty states
  C-11: SWR polling config
  C-12: Error visibility
  C-13: Destructive confirm
  C-14: Avatar fallback
  C-15: Input validation
  C-16: RBAC sidebar
  C-17-20: Minor fixes

Wave D (P3 Polish — last)
```

---

## 4. Issue index (TC → Fix family mapping)

| TC | Issue | Fix family | Wave | Status |
|---|---|---|---|---|
| TC-002a | Dashboard cards lack counts | F-ANALYTICS-PERM | B-1 | Open |
| TC-001b | Inaccurate counts (80 vs real 50) | F-ANALYTICS-PERM | B-1 | Open |
| TC-003a | "View All Reports" crashes | F-CRASHING-PAGE | — | ✅ Fixed Wave 8 |
| TC-004a | Growth tab inaccurate | F-DASHBOARD-DATA | B-1 (after perm fix) | Open |
| TC-008 | Sidebar items inappropriate for employee role | F-RBAC-SIDEBAR | C-16 | Open |
| TC-009 | Assigned task not visible in employee portal | F-CRUD-COMPLETE | B-6 | Open |
| TC-013 | Salary slips not visible | F-SALARY-SLIPS-API | B-4 | Open |
| TC-018 | Forgot Password doesn't work | F-FORGOT-PASSWORD | B-3 | Open |
| TC-019 | No scroll bar | F-CSS-SCROLL | C-19 | Open |
| TC-020 | UI/UX inconsistencies | F-UI-POLISH | D | Open |
| TC-025 | Cannot update employee names | F-CRUD-COMPLETE | B-6 | Open |
| TC-026 | Tasks empty on employee detail | F-CRUD-COMPLETE | B-6 | Open |
| TC-027 | Document upload missing | F-MISSING-FEATURE | Backlog | Open |
| TC-028 | Extra hours missing | F-MISSING-FEATURE | Backlog | Open |
| TC-029 / TC-202 | No delete button | F-MISSING-UI | — | ✅ Fixed Wave 8 |
| TC-030 | Performance review doesn't work | F-CRUD-COMPLETE | B-6 | Open |
| TC-031 | View All Performance crashes | F-CRASHING-PAGE | B-7 | Open |
| TC-032 | Changes not always saved | F-CRUD-COMPLETE | B-6 | Open |
| TC-033 | Inaccurate team counts | F-DASHBOARD-DATA | B-1 | Open |
| TC-034 | New teams cannot be created | F-CRUD-COMPLETE | B-6 | Open |
| TC-035 | No drag-and-drop in kanban | F-KANBAN-DND | D | Open |
| TC-036 | Assignees don't see tasks in dashboard | F-CRUD-COMPLETE | B-6 | Open |
| TC-037 | No valid project data | F-CRUD-COMPLETE | B-6 | Open |
| TC-038 | Calendar field unresponsive | F-INPUT-VALIDATION | C-15 | Open |
| TC-039 | Project term ambiguous | F-TERMINOLOGY | Backlog | Open |
| TC-040 | No sorting in Accounts | F-SORT-FILTER | Backlog | Open |
| TC-041 | Duplicate account names | F-INPUT-VALIDATION | C-15 | Open |
| TC-042 | Clients can't be deleted/modified | F-CRUD-COMPLETE | B-6 | Open |
| TC-043 | Clients lackluster | F-MISSING-FEATURE | Backlog | Open |
| TC-044 | Projects can't be deleted/edited | F-CRUD-COMPLETE | — | ✅ Fixed Wave 8 |
| TC-045 | No sorting in projects | F-SORT-FILTER | Backlog | Open |
| TC-046 | Reports limited data | F-DASHBOARD-DATA | B-1 | Open |
| TC-047 | Not all employees displayed | F-CRUD-COMPLETE | B-6 | Open |
| TC-048 | Leaderboard math skewed | F-LEADERBOARD-MATH | D-4 | Open |
| TC-049 | Reports UI/UX messed up | F-UI-POLISH | D | Open |
| TC-050 | Attendance doesn't work | F-MISSING-ENDPOINT | B-6 | Open |
| TC-051 | Approvals doesn't work | F-MISSING-ENDPOINT | B-6 | Open |
| TC-052 | Salary slips don't work | F-SALARY-SLIPS-API | B-4 | Open |
| TC-053 | Offer Letters don't work | F-CRUD-COMPLETE | B-6 | Open |
| TC-054 | Holidays don't display | F-HOLIDAYS-API | B-5 | Open |
| TC-055 | Cannot add holidays | F-HOLIDAYS-API | B-5 | Open |
| TC-056 | Job posting form lackluster | F-FORM-AFFORDANCE | C-8 | Open |
| TC-057 | Jobs lack sorting/filtering | F-SORT-FILTER | Backlog | Open |
| TC-058 | Bug reports don't work | F-CRUD-COMPLETE | B-6 | Open |
| TC-059 | AI form no input validation | F-INPUT-VALIDATION | C-15 | Open |
| TC-060 | AI hallucinates | F-AI-RELIABILITY | Backlog | Open |
| TC-061/063/065 | AI employee dropdown empty | F-AI-EMPLOYEE-DROPDOWN | B-2 | Open |
| TC-062/064/066/067/068 | AI doesn't work | F-AI-RELIABILITY | Backlog | Open |
| TC-069 | Import Accounts doesn't work | F-CRUD-COMPLETE | B-6 | Open |
| TC-070 | Analytics inaccurate | F-DASHBOARD-DATA | B-1 | Open |
| TC-071 | Missing visualizations | F-MISSING-FEATURE | Backlog | Open |
| TC-072 | Workload data missing | F-MISSING-ENDPOINT | B-6 | Open |
| TC-073 | Workload UI lackluster | F-UI-POLISH | D | Open |
| TC-074 | Expenses don't work | F-CRUD-COMPLETE | B-6 | Open |
| TC-075 | Returned devices can't be reassigned | F-CRUD-COMPLETE | B-6 | Open |
| TC-076 | Auto Teams doesn't work | F-CRUD-COMPLETE | B-6 | Open |
| TC-077 | Internships inconsistent | F-CRUD-COMPLETE | B-6 | Open |
| TC-078 | Complaints privacy issues | F-COMPLAINTS-PRIV | B-6 | Open |
| TC-079 | Complaints stages can't be altered | F-CRUD-COMPLETE | B-6 | Open |
| TC-080 / TC-153 / TC-165 | Analytics 403 (perm bug) | F-ANALYTICS-PERM | B-1 | Open |
| TC-081 / TC-154 / TC-163 | AI dropdown wrong endpoint | F-AI-EMPLOYEE-DROPDOWN | B-2 | Open |
| TC-082 | Analytics fired on every page | F-ANALYTICS-SCOPE | C-11 | Open |
| TC-083 | View button wrong URL | F-NAV-CORRECTNESS | C-9 | Open |
| TC-084 / TC-144 | Profile always in edit mode | F-PROFILE-VIEW-MODE | C-4 | Open |
| TC-085 / TC-161 | Blank page titles | F-PAGE-TITLES | C-2 | Open |
| TC-086 / TC-162 | Add employee form no affordance | F-FORM-AFFORDANCE | C-8 | Open |
| TC-087 / TC-164 | Salary slips duplicate month selector | F-DEDUP-CONTROLS | C-6 | Open |
| TC-089 / TC-170 | "More" hides 16+ features | F-NAV-RESTRUCTURE | C (low priority) | Open |
| TC-093 / TC-171 | Login placeholder hardcoded | F-LOGIN-COPY | C-7 | Open |
| TC-095 / TC-143 / TC-166 | Workload columns empty for 0 | F-WORKLOAD-COLUMNS | C-5 | Open |
| TC-097 / TC-173 | Greeting wrong timezone | F-CLIENT-TZ | C-18 | Open |
| TC-108 / TC-157 | Default credentials in source | F-DEFAULT-CREDENTIALS | A-2 | Open |
| TC-110 | Tokens in localStorage | F-TOKEN-STORAGE | A-4 | Open |
| TC-111 | Refresh loop | F-REFRESH-LOOP | B-8 | Open |
| TC-112 / TC-113 | AI preview XSS | F-AI-PREVIEW-SANDBOX | A-1 | Open |
| TC-114 | Silent empty dropdown | F-ERROR-VISIBILITY | C-12 | Open |
| TC-117 | Hardcoded 2024 year | F-DATE-DRIFT | C-6 (covered) | Open |
| TC-118 | PENDING_APPROVAL not formatted | F-STATUS-LABELS | C-1 | Open |
| TC-120 | Jobs detail panel no auto-refresh | F-SWR-POLLING | C-11 | Open |
| TC-121 | Extra hours no confirm dialog | F-DESTRUCTIVE-CONFIRM | C-13 | Open |
| TC-123 | Review button 404 | F-DEAD-LINKS | — | ✅ Fixed Phase 1 |
| TC-124 / TC-201 | Avatar fallback broken | F-AVATAR-FALLBACK | C-14 | Open |
| TC-131 | Sidebar SWR polls on every page | F-SWR-POLLING | C-11 | Open |
| TC-132 | 8 parallel requests employee detail | F-REQUEST-COALESCE | Backlog | Open |
| TC-133 | Jobs polls every 30s | F-SWR-POLLING | C-11 | Open |
| TC-135 | Incentive month 0 or 13 | F-INPUT-VALIDATION | C-15 | Open |
| TC-136 | FULL_TIME label underscored | F-STATUS-LABELS | C-1 | Open |
| TC-137 | Avatar no alt text | F-A11Y-LABELS | D-2 | Open |
| TC-138 | AI dropdown no a11y label | F-A11Y-LABELS | D-2 | Open |
| TC-139 | X buttons no accessible label | F-A11Y-LABELS | D-2 | Open |
| TC-140 | Login shake animation broken | F-UI-POLISH | D-3 | Open |
| TC-141 / TC-167 | Projects empty state blank | F-EMPTY-STATE | C-10 | Verify |
| TC-142 | AI Chat no auto-scroll | F-CHAT-SCROLL | D-1 | Open |
| TC-145 | AI duplicate salary slip viewer | F-DEDUP-VIEWERS | C (add-on) | Open |
| TC-146 | Attendance API 404 | F-MISSING-ENDPOINT | B-6 | Open |
| TC-147 | Approvals API 404 | F-MISSING-ENDPOINT | B-6 | Open |
| TC-148 | Workload API 404 | F-MISSING-ENDPOINT | B-6 | Open |
| TC-149 | Admin clients API 404 | F-MISSING-ENDPOINT | B-6 | Open |
| TC-150 | Leaderboard API 404 | F-MISSING-ENDPOINT | B-6 | Open |
| TC-151 | Holidays API 500 | F-HOLIDAYS-API | B-5 | Open |
| TC-152 | Salary slips API 500 | F-SALARY-SLIPS-API | B-4 | Open |
| TC-155 / TC-172 | Login fake stats | F-FAKE-STATS | C-3 | Open |
| TC-156 | Dashboard constant polling | F-SWR-POLLING | C-11 | Open |
| TC-159 | Multiple /admin/* missing | F-MISSING-ENDPOINT | B-6 | Open |
| TC-161 | Empty page titles (verified) | F-PAGE-TITLES | C-2 | Open |
| TC-162 | Add employee no affordance (verified) | F-FORM-AFFORDANCE | C-8 | Open |
| TC-163 | AI dropdowns empty (verified) | F-AI-EMPLOYEE-DROPDOWN | B-2 | Open |
| TC-165 | Dashboard all zeros (verified) | F-ANALYTICS-PERM | B-1 | Open |
| TC-166 | Empty workload cells (verified) | F-WORKLOAD-COLUMNS | C-5 | Open |
| TC-168 | Holidays swallows 500 (verified) | F-ERROR-VISIBILITY | C-12 | Open |
| TC-169 | Jobs "Auto-refreshes every 30s" visible | F-UI-POLISH | D | Open |
| TC-170 | 15 features in More (verified) | F-NAV-RESTRUCTURE | C | Open |
| TC-171 | Login placeholder (verified) | F-LOGIN-COPY | C-7 | Open |
| TC-172 | Login fake stats (verified) | F-FAKE-STATS | C-3 | Open |
| TC-173 | Greeting TZ (verified) | F-CLIENT-TZ | C-18 | Open |
| TC-176 | Frontend swallows errors (verified) | F-ERROR-VISIBILITY | C-12 | Open |
| TC-177 | Fresh seed only 1 user (verified) | F-SEED-DEMO | Backlog | Open |
| TC-200 | Script tag accepted in Name field | F-INPUT-SANITIZATION | A-3 | Open |
| TC-201 | Avatar shows < for non-alpha | F-AVATAR-FALLBACK | C-14 | Open |
| TC-203 | Complaints shows IN_REVIEW raw | F-STATUS-LABELS | C-1 | Open |
| TC-204 | Bug reports shows IN_PROGRESS raw | F-STATUS-LABELS | C-1 | Open |
| TC-205 | Internships ALL_CAPS status | F-STATUS-LABELS | C-1 | Open |
| TC-206 | Empty kanban no add prompt | F-EMPTY-STATE | C-10 | Open |
| TC-207 | Teams stat cards show 0 | F-EMPTY-STATE | C-10 | Verify |
| TC-220 | UPPER_SNAKE_CASE across portals | F-STATUS-LABELS | C-1 | Open |

---

## 5. Files changed per wave (summary)

### Wave A files
- `apps/internal/src/app/ai-assistant/page.tsx`
- `packages/db/prisma/seed.ts`
- `packages/shared/src/validators/` (multiple)
- `apps/api/src/routes/auth.routes.ts`
- `apps/api/src/middleware/auth.ts`
- `apps/internal/src/lib/auth.ts`
- `apps/internal/src/lib/api.ts`

### Wave B files
- `packages/db/prisma/seed.ts` (analytics permission)
- `apps/internal/src/app/ai-assistant/page.tsx` (endpoint URL)
- `apps/internal/src/app/login/page.tsx` (forgot password)
- `apps/api/src/routes/auth.routes.ts` (reset endpoints)
- `apps/api/src/services/auth.service.ts` (reset logic)
- `apps/api/src/services/salary-slip.service.ts`
- `apps/api/src/services/holiday.service.ts`
- Various SWR hook files (endpoint URL fixes)
- `apps/internal/src/app/employees/[id]/performance/page.tsx`
- `apps/internal/src/lib/api.ts` (refresh loop)

### Wave C files
- `packages/shared/src/utils/status.ts` (new)
- `apps/internal/src/app/layout.tsx`
- `apps/internal/src/lib/hooks/use-page-title.ts` (new)
- Every `page.tsx` in internal portal (page titles)
- `apps/internal/src/app/login/page.tsx` (fake stats, copy)
- `apps/internal/src/app/employees/[id]/page.tsx` (profile view mode)
- `apps/internal/src/app/workload/page.tsx`
- `apps/internal/src/app/salary-slips/page.tsx`
- `apps/internal/src/components/employee-form.tsx`
- `apps/internal/src/components/sidebar.tsx` (RBAC gating)
- `apps/internal/src/components/page-error.tsx` (new)
- `apps/internal/src/app/holidays/page.tsx`
- `apps/internal/src/lib/hooks/` (SWR options)

### Wave D files
- `apps/internal/src/app/ai-assistant/page.tsx` (scroll)
- All Avatar usages (alt text)
- Modal X buttons (aria-label)
- `apps/internal/src/app/reports/leaderboard/page.tsx`
- `apps/api/src/services/leaderboard.service.ts`

---

## 6. Open questions / verification needed

1. **TC-146–TC-150 (404s):** Are these route-mounting issues or frontend-URL mismatches? Need to run the API locally and curl each endpoint with a valid token to confirm which endpoints actually 404 vs which have wrong frontend URL.
2. **TC-110 token storage:** Confirm current implementation — is it `localStorage`, `sessionStorage`, or already cookies? Read `apps/internal/src/lib/auth.ts` fully.
3. **TC-031 Performance page crash:** Reproduce locally — check browser console for the exact error.
4. **TC-038 Calendar unresponsive:** Reproduce locally — check if it's a z-index/portal issue with the date picker.
5. **TC-085 page titles:** Confirm that adding `usePageTitle()` via useEffect works in production (Next.js App Router client components).
6. **TC-200 XSS:** Confirm whether the frontend or backend is the right layer to sanitize (answer: both — sanitize at API boundary with Zod, AND sanitize before rendering with DOMPurify for any HTML content fields).
