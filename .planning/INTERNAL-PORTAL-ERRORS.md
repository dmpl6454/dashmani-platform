# Internal Admin Portal — Error Log

**Purpose:** A living log of concrete errors observed in the internal admin portal — from static analysis, runtime reproduction, server logs, browser console, and user reports. Each entry is a self-contained record so anyone fixing the bug doesn't need to re-derive the context.

**How to use this file:**
- When a new error is observed, append an entry under "Open errors" using the template at the bottom.
- When an error is fixed, move it to "Resolved errors" with the resolving commit hash and verification notes.
- Pair each entry with the corresponding **Issue #** in [INTERNAL-PORTAL-AUDIT.md](./INTERNAL-PORTAL-AUDIT.md) when one exists.
- Keep entries terse but precise. Stack traces, request/response pairs, and reproduction steps go inside the entry, not in a separate file.

---

## Open errors

### ERR-I-030 — AI Preview XSS — generated HTML rendered unsanitized (P0)

- **Linked to:** V2 Plan A-1 / TC-112, TC-113
- **Severity:** P0
- **Type:** Security — XSS
- **Location:** `apps/internal/src/app/ai-assistant/page.tsx` — `dangerouslySetInnerHTML` usages + "open in new tab" flow
- **Symptom:** AI-generated document HTML is rendered directly into the DOM and can be opened in a new tab without any sanitization. A malicious AI response (or prompt injection) could execute scripts in the user's browser.
- **Fix required:** Install `dompurify`; wrap all `dangerouslySetInnerHTML` with `DOMPurify.sanitize()`; for new-tab open, write to a Blob URL not raw HTML; add `sandbox` attr to preview iframes.
- **Status:** Open — 2026-05-16

---

### ERR-I-031 — Default admin credentials hardcoded in seed.ts (P0)

- **Linked to:** V2 Plan A-2 / TC-108, TC-157
- **Severity:** P0
- **Type:** Security — Hardcoded credentials
- **Location:** `packages/db/prisma/seed.ts` — `admin@digitalsukoon.com / Admin@123456`
- **Symptom:** The default admin password is publicly visible in source control and was confirmed working on production (TC-157). Anyone with source access can log in to production.
- **Fix required:** Replace hardcoded password with `process.env.SEED_ADMIN_PASSWORD` (throw if unset). Rotate production password operationally. Add to `.env.example`.
- **Status:** Open — 2026-05-16

---

### ERR-I-032 — Backend accepts `<script>` in Name field — returns 201 (P0)

- **Linked to:** V2 Plan A-3 / TC-200
- **Severity:** P0
- **Type:** Security — XSS / Input injection
- **Location:** `apps/api/src/routes/employee.routes.ts` (and likely other create routes) — no HTML sanitization on string fields
- **Symptom:** POST to `/employees` with `name: "<script>alert(1)</script>"` returns HTTP 201. The script tag is stored and later rendered, creating a stored XSS vector.
- **Fix required:** Add `safeString` Zod transformer to all free-text fields in `packages/shared/src/validators/`; strip HTML tags at API boundary.
- **Status:** Open — 2026-05-16

---

### ERR-I-033 — Auth tokens stored in localStorage — XSS theft risk (P0)

- **Linked to:** V2 Plan A-4 / TC-110
- **Severity:** P0
- **Type:** Security — Insecure token storage
- **Location:** `apps/internal/src/lib/auth.ts` + `apps/internal/src/lib/api.ts`
- **Symptom:** JWT stored in `localStorage`. Any XSS (including the AI preview bug above) can steal the token and impersonate the user indefinitely.
- **Fix required:** Move to httpOnly cookies: API sets `Set-Cookie` on login; middleware reads cookie; remove all localStorage token reads/writes from frontend.
- **Status:** Open — 2026-05-16

---

### ERR-I-034 — Analytics returns 403 — "analytics" permission missing from seed (P1)

- **Linked to:** V2 Plan B-1 / TC-080, TC-153, TC-165
- **Severity:** P1
- **Type:** Configuration bug — missing RBAC permission
- **Location:** `packages/db/prisma/seed.ts` — Super Admin and Admin role resource lists
- **Symptom:** All analytics pages show zero data. `GET /analytics/overview` returns 403 "No permission: view on analytics". Root cause confirmed: `"analytics"` resource is absent from both Super Admin and Admin role definitions in seed.
- **Root cause:** Seed defines resources `["employees","teams","tasks","accounts","reports","attendance","roles","settings","clients","content","messages","billing"]` — no `"analytics"` entry.
- **Fix required:** Add `"analytics"` to Super Admin and Admin resource arrays in `seed.ts`; reseed.
- **Status:** Open — 2026-05-16

---

### ERR-I-035 — AI Assistant employee dropdown calls wrong endpoint — /admin/employees 404 (P1)

- **Linked to:** V2 Plan B-2 / TC-061, TC-063, TC-065, TC-081, TC-154, TC-163
- **Severity:** P1
- **Type:** Wrong API path
- **Location:** `apps/internal/src/app/ai-assistant/page.tsx:30`
- **Symptom:** All AI document tabs (Offer Letter, Appointment Letter, Employment Contract, Salary Slip) have an empty employee dropdown. Verified: page calls `GET /admin/employees` which returns 404. Correct path is `GET /employees`.
- **Fix:** Change line 30 from `/admin/employees` to `/employees`. One-line fix.
- **Status:** Open — 2026-05-16

---

### ERR-I-036 — Forgot Password missing from internal portal login (P1)

- **Linked to:** V2 Plan B-3 / TC-018
- **Severity:** P1
- **Type:** Missing feature
- **Location:** `apps/internal/src/app/login/page.tsx` — no "Forgot password?" link
- **Symptom:** Users who forget their admin password have no self-service recovery path. Must go through a developer to reset via DB.
- **Fix required:** Implement `POST /auth/forgot-password` + `POST /auth/reset-password` API endpoints (with token expiry and email delivery); add "Forgot password?" link + modal to login page; add `/reset-password` page.
- **Status:** Open — 2026-05-16

---

### ERR-I-037 — Salary Slips API returns 500 (P1)

- **Linked to:** V2 Plan B-4 / TC-013, TC-052, TC-152
- **Severity:** P1
- **Type:** Runtime error — Prisma query failure
- **Location:** `apps/api/src/routes/admin-features.routes.ts` salary slips section + `apps/api/src/services/salary-slip.service.ts`
- **Symptom:** `GET /admin/salary-slips` returns HTTP 500. Salary slips page in internal portal shows nothing.
- **Fix required:** Investigate the Prisma query in `salary-slip.service.ts`; fix the failing query (likely a missing include, bad field name, or schema mismatch after db:push). Add proper error logging.
- **Status:** Open — 2026-05-16

---

### ERR-I-038 — Holidays API returns 500 (P1)

- **Linked to:** V2 Plan B-5 / TC-054, TC-055, TC-151
- **Severity:** P1
- **Type:** Runtime error — Prisma query failure
- **Location:** `apps/api/src/routes/admin-features.routes.ts` holidays section + `apps/api/src/services/holiday.service.ts`
- **Symptom:** `GET /admin/holidays` returns HTTP 500. Holidays page silently shows "No holidays for 2026" without revealing the underlying 500 error.
- **Fix required:** Fix the Prisma query in `holiday.service.ts`; fix error visibility on the frontend.
- **Status:** Open — 2026-05-16

---

### ERR-I-039 — Multiple admin/* endpoints return 404 (P1)

- **Linked to:** V2 Plan B-6 / TC-146–TC-150, TC-159
- **Severity:** P1
- **Type:** Route mismatch or missing route
- **Location:** `apps/internal/src/lib/hooks/` — SWR hooks for attendance, approvals, workload, clients, leaderboard
- **Symptom:** Production testing confirmed: `GET /attendance` 404, `GET /approvals` 404, `GET /workload` 404, `GET /admin/clients` 404, `GET /leaderboard` 404. Routes exist in route files but may not be mounted or frontend calls wrong URL.
- **Fix required:** Audit each SWR hook URL against actual mounted route; fix mismatches. If routes genuinely missing, create them.
- **Status:** Open — 2026-05-16

---

### ERR-I-040 — Session refresh retry loop — page crash on token expiry (P1)

- **Linked to:** V2 Plan B-8 / TC-111
- **Severity:** P1
- **Type:** Logic error — infinite retry
- **Location:** `apps/internal/src/lib/api.ts` — refresh token interceptor
- **Symptom:** When the session expires and the refresh token call also fails, the API client retries indefinitely. Page crashes or becomes unresponsive instead of redirecting to login.
- **Fix required:** Cap refresh retries at 1; on final failure, clear auth state and redirect to `/login`.
- **Status:** Open — 2026-05-16

---

### ERR-I-041 — Login page shows hardcoded fake stats (P2)

- **Linked to:** V2 Plan C-3 / TC-155, TC-172
- **Severity:** P2
- **Type:** Content — fake/misleading data
- **Location:** `apps/internal/src/app/login/page.tsx` lines 127–168
- **Symptom:** Right-side decorative panel displays "Team Overview: 24 Active / 8 Pending / 142 Tasks", "36 Active Projects", "12 posts scheduled", "85% Efficiency Score". All hardcoded — not real data.
- **Fix required:** Replace with static branded content (logo, quote, or illustration) with no fake metrics.
- **Status:** Open — 2026-05-16

---

### ERR-I-042 — All internal portal page titles are blank (P2)

- **Linked to:** V2 Plan C-2 / TC-085, TC-161
- **Severity:** P2
- **Type:** UX — missing metadata
- **Location:** All `page.tsx` files in `apps/internal/src/app/`
- **Symptom:** Browser tab shows the app's generic title for every page — no page-specific title. All pages use `"use client"` so `export const metadata` is not available.
- **Fix required:** Add `usePageTitle()` hook (useEffect sets document.title) to every page; set fallback title in root layout.
- **Status:** Open — 2026-05-16

---

### ERR-I-043 — Employee profile tab opens in edit mode by default (P2)

- **Linked to:** V2 Plan C-4 / TC-084, TC-144
- **Severity:** P2
- **Type:** UX — unexpected default state
- **Location:** `apps/internal/src/app/employees/[id]/page.tsx` — profile tab
- **Symptom:** Clicking an employee opens the profile tab with the edit form visible. There is no read-only view; the user is immediately in edit mode.
- **Fix required:** Add read-only info display as default; show "Edit" button to enter edit mode; `isEditingProfile` defaults to `false`.
- **Status:** Open — 2026-05-16

---

### ERR-I-044 — Workload Critical/High columns empty when count is 0 (P2)

- **Linked to:** V2 Plan C-5 / TC-095, TC-143, TC-166
- **Severity:** P2
- **Type:** UI logic error — conditional render hides zeros
- **Location:** `apps/internal/src/app/workload/page.tsx` lines 52-61
- **Symptom:** Workload matrix cells for Critical and High priority columns are completely empty when an employee has zero tasks of that priority. The absence of content looks like a rendering error.
- **Fix required:** Always render the cell value; show `0` or `—` instead of nothing.
- **Status:** Open — 2026-05-16

---

### ERR-I-045 — Salary slips page has duplicate month selector + hardcoded 2024 year (P2)

- **Linked to:** V2 Plan C-6 / TC-087, TC-117, TC-164
- **Severity:** P2
- **Type:** UI duplication + hardcoded value
- **Location:** `apps/internal/src/app/salary-slips/page.tsx` lines 69-85
- **Symptom:** Two month selectors appear simultaneously. Month names generated using `new Date(2024, i)` — in 2026 and beyond they still show 2024 month labels.
- **Fix required:** Move the bulk-generation month picker into the modal; keep only the filter selector visible. Replace `2024` with `new Date().getFullYear()`.
- **Status:** Open — 2026-05-16

---

### ERR-I-046 — Add Employee form missing fields and affordance (P2)

- **Linked to:** V2 Plan C-8 / TC-086, TC-162
- **Severity:** P2
- **Type:** Missing form fields + UX affordance
- **Location:** `apps/internal/src/components/employee-form.tsx`
- **Symptom:** The Add Employee form only has Name, Email, Password, Phone, Roles. Missing: Job Title, Department, Start Date, Manager. No placeholder text on existing fields.
- **Fix required:** Add missing fields to EmployeeForm; add `required` markers; add placeholder text; extend shared validator and API handler.
- **Status:** Open — 2026-05-16

---

### ERR-I-047 — Status labels shown as UPPER_SNAKE_CASE across internal portal (P2)

- **Linked to:** V2 Plan C-1 / TC-118, TC-136, TC-204, TC-220
- **Severity:** P2
- **Type:** UI formatting — raw enum values displayed to users
- **Location:** `apps/internal/src/app/jobs/page.tsx:244`, `apps/internal/src/app/ai-assistant/page.tsx:369`, `apps/internal/src/app/bug-reports/page.tsx`, and others
- **Symptom:** Job type shows `FULL_TIME` / `PART_TIME`; application status shows `REVIEWING`; bug report filter shows `IN_PROGRESS`; salary slip status shows raw values in AI assistant tab.
- **Fix required:** Create `packages/shared/src/utils/status.ts` with `formatStatus()` function; apply across all affected pages.
- **Status:** Open — 2026-05-16

---

### ERR-I-048 — "View" button on employees list links to wrong page (P2)

- **Linked to:** V2 Plan C-9 / TC-083
- **Severity:** P2
- **Type:** Navigation error
- **Location:** `apps/internal/src/app/employees/page.tsx` — View button href
- **Symptom:** "View" button navigates to `/employees/:id/performance` instead of `/employees/:id`. Breadcrumb on the performance page says "Employees / Reports" incorrectly.
- **Fix required:** Change View link to `/employees/:id`; fix breadcrumb on performance page.
- **Status:** Open — 2026-05-16

---

### ERR-I-049 — Login email placeholder is domain-specific (P2)

- **Linked to:** V2 Plan C-7 / TC-093, TC-171
- **Severity:** P2 (P3 per test sheet)
- **Type:** Content — hardcoded tenant-specific copy
- **Location:** `apps/internal/src/app/login/page.tsx` — email input placeholder
- **Symptom:** Placeholder text reads `you@digitalsukoon.com` which is confusing if the product is ever multi-tenant or a different team uses it.
- **Fix required:** Change placeholder to `Enter your email address`.
- **Status:** Open — 2026-05-16

---

### ERR-I-020 — Announcement emails never sent (SMTP not configured + unawaited Promise)

- **Linked to:** AUDIT Issue 17 / internal-portal-plan.md Phase 12
- **Severity:** P1
- **Type:** Configuration gap + code bug
- **Location:**
  - `apps/api/.env` — missing `SMTP_USER` / `SMTP_PASS` / `SMTP_HOST` variables
  - [apps/api/src/services/announcement.service.ts:38](../apps/api/src/services/announcement.service.ts#L38) — unawaited `Promise.allSettled`
  - [apps/api/src/services/email.service.ts:26-28](../apps/api/src/services/email.service.ts#L26) — early-return guard when SMTP vars absent
- **Symptom:** Admin sends a broadcast announcement — in-app notifications arrive correctly but no email is received by any employee.
- **Root causes (two, both must be fixed):**
  1. **Missing env vars (primary blocker):** `apps/api/.env` contains only `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `NEXT_PUBLIC_API_URL`, and `PORT`. `SMTP_USER` and `SMTP_PASS` are absent. `sendEmail()` in `email.service.ts` checks for these at line 26 and returns `null` with a `console.warn` — no email is attempted. `.env.example` also lacks SMTP entries, so the gap was never surfaced during setup.
  2. **Unawaited Promise (secondary):** `announcement.service.ts:38` calls `Promise.allSettled(...)` without `await`. The function returns `{ recipientCount, announcementId }` before any email promise resolves. Even once SMTP is configured, if the Node process is under pressure or the SMTP connection is slow, the fire-and-forget can be abandoned. (In-app notifications are unaffected because `notification.createMany` is correctly awaited.)
- **Fix required:**
  1. Add SMTP credentials to `apps/api/.env` (and to `.env.example` so future devs know to fill it in):
     ```
     SMTP_HOST=smtp.gmail.com
     SMTP_PORT=587
     SMTP_SECURE=false
     SMTP_USER=<sender-gmail-address>
     SMTP_PASS=<app-password>
     INTERNAL_APP_URL=http://localhost:3000
     ```
  2. Change line 38 of `announcement.service.ts` from `Promise.allSettled(...)` to `await Promise.allSettled(...)` so email dispatch completes before the function returns.
- **Verification:** After adding SMTP env vars and restarting the API, send a test announcement → confirm email arrives at `tabish@dashmani.com` within 60 seconds. Check API server log for `✉ Email sent to ...` confirmation line.
- **Status:** Open — 2026-05-16

---

## Resolved errors (Wave 9, commit 1e92b20)

### ERR-I-017 — No broadcast announcement capability

- **Linked to:** AUDIT Issue 17
- **Severity:** P1
- **Type:** Missing feature
- **Fix:** Schema `ANNOUNCEMENT` enum + `Announcement` model. `broadcastAnnouncement()` service. `POST/GET /admin/announcements` routes. `/announcements` page + dashboard CTA banner + top-nav `Announce` pill.
- **Status:** ✅ Resolved — commit 1e92b20

---

### ERR-I-018 — Notifications not expandable in internal admin portal

- **Linked to:** AUDIT Issue 18
- **Severity:** P1
- **Type:** UX bug — missing interaction
- **Location:** [apps/internal/src/components/top-nav.tsx](../apps/internal/src/components/top-nav.tsx)
- **Symptom:** Clicking a notification only called `markAsRead`. Full message body was truncated and never accessible. Read notifications were entirely unclickable (`onClick` gated by `!n.read`).
- **Fix:** Added `selectedNotif` state. Clicking any notification opens an inline detail panel (full title, full `whitespace-pre-wrap` message, formatted timestamp). Back chevron returns to list. Unread auto-marked read on open.
- **Status:** ✅ Resolved — commit 1e92b20

---

### ERR-I-019 — Notifications not expandable in HR/employee portal

- **Linked to:** AUDIT Issue 19
- **Severity:** P1
- **Type:** UX bug — missing interaction
- **Location:** [apps/hr/src/components/notification-bell.tsx](../apps/hr/src/components/notification-bell.tsx)
- **Symptom:** Same as ERR-I-018. `onClick` was `() => !notif.read && handleMarkRead(id)` — already-read notifications did nothing on click.
- **Fix:** Rewrote with same `selectedNotif` detail-panel pattern. All notifications always clickable. Added `timeAgo()` helper consistent with internal portal.
- **Status:** ✅ Resolved — commit 1e92b20

---

## New errors found and resolved (Wave 8, commit dad9b5f)

### ERR-I-012 — `reports/[employeeId]` crashes: "An unsupported type was passed to use()"

- **Linked to:** AUDIT Issue 12
- **Severity:** P0
- **Type:** Runtime error
- **Location:** [apps/internal/src/app/reports/[employeeId]/page.tsx:26](../apps/internal/src/app/reports/%5BemployeeId%5D/page.tsx#L26)
- **Symptom:** Clicking "View all reports" for any employee in the internal portal throws an unhandled runtime error and shows a Next.js error overlay.
- **What happened:** `React.use(params)` was called with a plain object `{ employeeId: string }` (not a Promise). `React.use()` does not support plain objects.
- **Fix:** Removed `use` import and `use(params)` call; replaced with direct destructuring `const { employeeId } = params`.
- **Status:** Resolved — commit dad9b5f

---

### ERR-I-013 — No user or client deletion capability

- **Linked to:** AUDIT Issue 13
- **Severity:** P1
- **Type:** Missing feature
- **Location:** `apps/api/src/routes/admin-features.routes.ts` — no DELETE endpoints for users or clients
- **Fix:** Added `DELETE /admin/users/:id` (soft-delete via `deletedAt + status=INACTIVE`) and `DELETE /admin/clients/:id` (hard delete). Both require caller role "Admin" or "Super Admin". Guards: cannot delete self, cannot delete super admin unless caller is also super admin.
- **Status:** Resolved — commit dad9b5f

---

### ERR-I-014 — No role assignment UI

- **Linked to:** AUDIT Issue 14
- **Severity:** P1
- **Type:** Missing feature
- **Location:** Employee detail page — no role management controls
- **Fix:** Added `PUT /admin/users/:id/roles` endpoint (atomic transaction, idempotent). Added `RoleManager` component in employee detail Profile tab — toggle-button UI for all system roles, save triggers PUT endpoint. Visible only to callers with Admin/Super Admin role.
- **Status:** Resolved — commit dad9b5f

---

### ERR-I-015 — Project end date can be earlier than start date

- **Linked to:** AUDIT Issue 15
- **Severity:** P2
- **Type:** Logic error / missing validation
- **Location:**
  - Frontend: [apps/internal/src/app/projects/new/page.tsx](../apps/internal/src/app/projects/new/page.tsx)
  - Backend: [apps/api/src/services/project.service.ts](../apps/api/src/services/project.service.ts)
- **Fix:** Client-side: `min` attribute on end date field; `onSubmit` check; start date change clears end date if it becomes invalid. Server-side: `createProject` and `updateProject` throw `AppError(400, "INVALID_DATES")` if `endDate < startDate`.
- **Status:** Resolved — commit dad9b5f

---

### ERR-I-016 — Client portal shows no projects even when projects are assigned

- **Linked to:** AUDIT Issue 16
- **Severity:** P2
- **Type:** UX / confusing default state
- **Location:** [apps/client/src/app/projects/page.tsx](../apps/client/src/app/projects/page.tsx)
- **What happened:** Default filter was `"active"`. Projects in `PAUSED`, `COMPLETED`, or other states were hidden. Users with newly assigned projects saw an empty list.
- **Fix:** Changed default filter from `"active"` to `"all"`. Improved empty state message to distinguish "no projects at all" vs "no projects match filter".
- **Note:** The underlying API and data model are correct — `GET /client/projects` filters by `clientId` correctly. This was purely a UX default issue.
- **Status:** Resolved — commit dad9b5f

---

## Resolved errors (pre-Wave 8)

### ERR-I-001 — `/employees/pending` 404s — backend route not reachable

- **Linked to:** AUDIT Issue 1
- **Severity:** P0
- **Type:** Route mounting gap
- **Status:** ✅ Resolved — commit f92e1a1

---

### ERR-I-002 — No admin self-signup or invite flow

- **Linked to:** AUDIT Issue 2
- **Severity:** P0
- **Type:** Missing feature
- **Status:** ✅ Resolved — commit f92e1a1

---

### ERR-I-003 — Employee profile data (bank details, ID, contacts) is read-only

- **Linked to:** AUDIT Issue 3
- **Severity:** P1
- **Type:** Missing feature
- **Status:** ✅ Resolved — commit f92e1a1

---

### ERR-I-004 — Attendance page locked to current month, no employee filter

- **Linked to:** AUDIT Issue 4
- **Severity:** P1
- **Type:** Missing UI control
- **Status:** ✅ Resolved — commit f92e1a1

---

### ERR-I-005 — No admin manual attendance entry / override

- **Linked to:** AUDIT Issue 5
- **Severity:** P2
- **Type:** Missing feature
- **Status:** ✅ Resolved — commit f92e1a1

---

### ERR-I-006 — Task detail has no reassign UI

- **Linked to:** AUDIT Issue 6
- **Severity:** P2
- **Type:** Missing feature
- **Status:** ✅ Resolved — commit f92e1a1

---

### ERR-I-007 — No client invite UI in internal portal

- **Linked to:** AUDIT Issue 7
- **Severity:** P1
- **Type:** Missing feature
- **Status:** ✅ Resolved — commit f92e1a1

---

### ERR-I-008 — No role colour-coding in employee list

- **Linked to:** AUDIT Issue 8
- **Severity:** P2
- **Type:** Missing UI polish
- **Status:** ✅ Resolved — commit 9ee3592

---

### ERR-I-009 — No loading.tsx in any route folder

- **Linked to:** AUDIT Issue 9
- **Severity:** P2
- **Type:** Missing UX guard
- **Status:** ✅ Resolved — 22 loading.tsx files created across all route folders

---

### ERR-I-010 — Analytics/tasks and analytics/content pages not verified — potential placeholder

- **Linked to:** AUDIT Issue 10
- **Severity:** P1 (conditional)
- **Type:** Potential placeholder / unverified wiring
- **Status:** ✅ Verified fully wired — no fixes needed (Phase 10 audit)

---

### ERR-I-011 — Null safety missing on performance review `reviewer` field

- **Linked to:** AUDIT Issue 11
- **Severity:** P3
- **Type:** Potential runtime TypeError
- **Status:** ✅ Resolved — commit f92e1a1 (falls back to "Unknown Reviewer")

---

## Resolved errors (pre-Wave 8, commit f92e1a1 and earlier)

---

## Append template

```markdown
### ERR-I-NNN — <one-line title>

- **Linked to:** AUDIT Issue N (or "—" if none)
- **Severity:** P0 | P1 | P2 | P3
- **Type:** Runtime | Static | API/UI contract | Repo hygiene | Inert UI | Mock-data leak | Missing feature | Route mounting | Other
- **Location:** `path/to/file.ts:line` (link with markdown if useful)
- **Symptom:** What the user sees.
- **Trigger:** Exact steps to reproduce.
- **What's actually happening:** The mechanism — request/response, type chain, state shape, etc.
- **Expected vs actual:** (if relevant; can include sample JSON)
- **Status:** Open / In progress / Resolved in `<commit>`
```
