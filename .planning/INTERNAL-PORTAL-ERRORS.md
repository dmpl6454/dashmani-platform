# Internal Admin Portal — Error Log

**Purpose:** A living log of concrete errors observed in the internal admin portal — from static analysis, runtime reproduction, server logs, browser console, and user reports. Each entry is a self-contained record so anyone fixing the bug doesn't need to re-derive the context.

**How to use this file:**
- When a new error is observed, append an entry under "Open errors" using the template at the bottom.
- When an error is fixed, move it to "Resolved errors" with the resolving commit hash and verification notes.
- Pair each entry with the corresponding **Issue #** in [INTERNAL-PORTAL-AUDIT.md](./INTERNAL-PORTAL-AUDIT.md) when one exists.
- Keep entries terse but precise. Stack traces, request/response pairs, and reproduction steps go inside the entry, not in a separate file.

---

## Open errors

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
