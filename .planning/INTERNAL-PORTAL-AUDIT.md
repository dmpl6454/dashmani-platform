# Internal Admin Portal — End-to-End Audit & Remediation Plan

**Date:** 2026-05-15 (last updated: 2026-05-15)
**Branch:** `docs/design-critique`
**Scope:** `apps/internal` + `apps/api` (internal/admin endpoints)
**Status:** Wave 9 complete — broadcast announcements (Issue 17) + notification detail view (Issues 18–19) — commit 1e92b20.

> Companion file: [INTERNAL-PORTAL-ERRORS.md](./INTERNAL-PORTAL-ERRORS.md) — full error log.
> Implementation plan: [internal-portal-plan.md](./internal-portal-plan.md) — phase-by-phase fix roadmap.

---

## TL;DR

The internal admin portal is structurally mature — ~46 pages, real CRUD operations, live API wiring, no mock-store data. Unlike the client portal, there are no systemic data-binding bugs. The issues are:

1. **One route isn't reachable** — the pending-employee approval endpoint is defined but likely not mounted (frontend 404s on it).
2. **No admin creation flow** — new admins can only be added via DB seed; there is no invite or direct-create UI.
3. **Several missing CRUD capabilities** — profile data editing, attendance manual entry, task reassignment, client invite trigger.
4. **Cross-portal integration gap** — the client portal invite endpoint exists and requires admin auth, but the internal portal has no button for it.
5. **UX polish gaps** — no loading skeletons, no role colour-coding, attendance is locked to the current month.

---

## Verified facts (read directly from source)

| Claim | Evidence |
|---|---|
| `GET /admin/employees/pending` is defined in `admin-reports.routes.ts:168-180` | [admin-reports.routes.ts:168](../apps/api/src/routes/admin-reports.routes.ts#L168) |
| Frontend `/employees/pending` calls `/admin/employees/pending` (line 24) | [employees/pending/page.tsx:24](../apps/internal/src/app/employees/pending/page.tsx#L24) |
| `auth.routes.ts` has only `/auth/login`, `/auth/refresh`, `/auth/logout` — no register or invite | [auth.routes.ts](../apps/api/src/routes/auth.routes.ts) |
| Admin user `tabish@dashmani.com` is created only via seed script (`status="ACTIVE"`, role="Super Admin") | [packages/db/prisma/seed.ts](../packages/db/prisma/seed.ts) — upsert block |
| HR self-register (`POST /hr/auth/register`) creates `status="ONBOARDING"` with `type="hr"` token — NOT usable for admin portal | [hr-auth.routes.ts:21-32](../apps/api/src/routes/hr-auth.routes.ts#L21-L32) |
| Employee detail page "Profile Data" tab fetches `/admin/employees/:id/profile-data` but has no save/edit button | [employees/[id]/page.tsx](../apps/internal/src/app/employees/%5Bid%5D/page.tsx) — `InfoField` component, no edit state |
| Only `PUT /admin/employees/:userId/profile` exists (designation, salary) — NOT profile data (bank, ID, contacts) | [admin-reports.routes.ts:213-225](../apps/api/src/routes/admin-reports.routes.ts#L213-L225) |
| Attendance page uses `new Date()` at render time for `startDate`/`endDate` with no state | [attendance/page.tsx:7-8](../apps/internal/src/app/attendance/page.tsx#L7-L8) |
| `GET /attendance` accepts `employeeId`, `startDate`, `endDate` params that the frontend never passes | [attendance.routes.ts:27-43](../apps/api/src/routes/attendance.routes.ts#L27-L43) |
| No `POST/PUT /attendance/manual` or override endpoint exists in attendance.routes.ts | [attendance.routes.ts](../apps/api/src/routes/attendance.routes.ts) — checked |
| Task detail shows assignee as static display; no dropdown or mutation call | [tasks/[id]/page.tsx](../apps/internal/src/app/tasks/%5Bid%5D/page.tsx) |
| `POST /v1/client/auth/invite-request` exists, requires `authenticate` + `requirePermission("clients","create")` | [client.routes.ts](../apps/api/src/routes/client.routes.ts) |
| Clients pages in internal portal have no "Invite to Portal" button | Grep across `apps/internal/src/app/clients/` — no invite-request call |
| Employee list renders role names as plain text with no colour differentiation | [employees/page.tsx](../apps/internal/src/app/employees/page.tsx) |
| No `loading.tsx` files exist anywhere under `apps/internal/src/app/` | Glob for `loading.tsx` in `apps/internal/src/app/` — zero results |
| Analytics sub-pages (`/analytics/content`, `/analytics/tasks`) — wiring status unverified | Not fully read — flagged for inspection |

---

## Issue Register

### Severity legend
- **P0 — Blocker:** Feature is unreachable or visibly broken to the user.
- **P1 — High:** Feature appears broken or a critical capability is absent.
- **P2 — Medium:** Cosmetic, confusing, or silently limits admin capability.
- **P3 — Cleanup:** Polish / code quality.

---

### ISSUE 1 — Pending employee approvals page 404s (P0)

**Symptom:** `/employees/pending` loads but immediately shows empty/error because `GET /admin/employees/pending` returns 404.

**Root cause:** Route is defined in `admin-reports.routes.ts:168` but likely not mounted in `apps/api/src/routes/index.ts`, or it's being shadowed. The frontend calls the correct URL.

**Fix:**
1. Read `apps/api/src/routes/index.ts` — confirm `admin-reports.routes.ts` is imported and router is mounted.
2. If missing import, add it. If present, check for route ordering issue (dynamic `:id` before `/pending`).

**Files:**
- [apps/api/src/routes/index.ts](../apps/api/src/routes/index.ts) — verify mount
- [apps/api/src/routes/admin-reports.routes.ts:168-210](../apps/api/src/routes/admin-reports.routes.ts#L168) — route definitions

**Plan phase:** Phase 1

---

### ISSUE 2 — No admin creation or invite flow (P0)

**Symptom:** Super admin cannot add new admins through the UI. The only admin account (`tabish@dashmani.com`) was bootstrapped by running the DB seed script directly.

**Root cause:** No invite or direct-create endpoint for internal admin users. The HR self-register flow (`/hr/auth/register`) creates HR-type users, not admin-type.

**Fix:**
- **(A — Recommended) Add `POST /admin/users/create`** — creates admin user directly with `status="ACTIVE"`, assigns roles, no approval step needed (super-admin-only action).
- **(B) Add invite flow** — `POST /admin/users/invite` emails a token; recipient completes signup at `/admin-signup?token=<uuid>`.
- Both can coexist; (A) for internal seeding, (B) for external collaborators.

**Files to create/edit:**
- `apps/api/src/routes/admin-features.routes.ts` — add endpoints
- `packages/db/prisma/schema.prisma` — add `AdminInvite` model
- `apps/internal/src/app/employees/add-admin/page.tsx` — new UI
- `apps/internal/src/app/admin-signup/page.tsx` — signup form
- `apps/internal/src/app/layout.tsx` — add `/admin-signup` to public routes

**Plan phase:** Phase 2

---

### ISSUE 3 — Employee profile data is read-only (P1)

**Symptom:** "Profile Data" tab in employee detail shows bank account, AADHAAR, PAN, family contacts, mailing address — but admin cannot correct typos or update stale data.

**Root cause:** `GET /admin/employees/:id/profile-data` fetches the data; no `PUT` counterpart exists. Frontend renders `InfoField` static components with no edit mode.

**Fix:**
1. Add `PUT /admin/employees/:id/profile-data` endpoint (update bank, ID, contacts fields).
2. Add edit mode toggle + form in the "Profile Data" tab.

**Files:**
- [apps/api/src/routes/admin-reports.routes.ts](../apps/api/src/routes/admin-reports.routes.ts) — add PUT route
- [apps/api/src/services/employee-profile.service.ts](../apps/api/src/services/employee-profile.service.ts) — add `updateEmployeeProfileData()`
- [apps/internal/src/app/employees/[id]/page.tsx](../apps/internal/src/app/employees/%5Bid%5D/page.tsx) — add edit state

**Plan phase:** Phase 3

---

### ISSUE 4 — Attendance locked to current month, no employee filter (P1)

**Symptom:** Admin navigates to `/attendance` — sees only the current month, always, for all employees combined. No way to review March attendance or look up a specific employee's history.

**Root cause:** `startDate` / `endDate` are hardcoded to `now` with no state. The `GET /attendance` endpoint supports filters (`employeeId`, `startDate`, `endDate`) that the frontend never sends.

**Fix:**
1. Add `viewYear`, `viewMonth` state + prev/next navigation chevrons.
2. Add employee dropdown (from `useEmployees()`) — pass `employeeId` to query.
3. Re-derive `startDate`/`endDate` from controlled state.

**Files:**
- [apps/internal/src/app/attendance/page.tsx](../apps/internal/src/app/attendance/page.tsx)

**Plan phase:** Phase 4a

---

### ISSUE 5 — No admin manual attendance entry or override (P2)

**Symptom:** If an employee misses check-in or checks in from a wrong location, the record is permanently absent/wrong. No correction mechanism.

**Root cause:** No `POST /attendance/manual` or `PUT /attendance/:id/override` endpoint. The existing `POST /attendance/check-in` is for employees only (scoped by their own auth token).

**Fix:**
1. Add `POST /attendance/manual` and `PUT /attendance/:id/override` protected by `requirePermission("attendance","edit")`.
2. Add "+ Add Record" button + edit icons on attendance table rows.

**Files:**
- [apps/api/src/routes/attendance.routes.ts](../apps/api/src/routes/attendance.routes.ts) — add admin routes
- [apps/api/src/services/attendance.service.ts](../apps/api/src/services/attendance.service.ts) — add methods
- [apps/internal/src/app/attendance/page.tsx](../apps/internal/src/app/attendance/page.tsx) — add UI

**Plan phase:** Phase 4b/4c

---

### ISSUE 6 — Task detail has no reassign UI (P2)

**Symptom:** Admin views a task — sees the current assignee — but cannot reassign it to someone else from this view. Must go to an external process.

**Root cause:** The frontend shows `task.assignee.name` as static text. No dropdown or PUT call to change it.

**Fix:**
1. Confirm `PUT /tasks/:id` accepts `assigneeId` — if so, add employee dropdown to task detail.
2. If not, add `PATCH /tasks/:id/assignee`.

**Files:**
- [apps/internal/src/app/tasks/[id]/page.tsx](../apps/internal/src/app/tasks/%5Bid%5D/page.tsx)
- [apps/api/src/routes/task.routes.ts](../apps/api/src/routes/task.routes.ts) — verify/extend

**Plan phase:** Phase 5

---

### ISSUE 7 — No client portal invite button in internal portal (P1)

**Symptom:** Admin cannot send a client their portal invite from the UI. They must use the API directly.

**Root cause:** `POST /v1/client/auth/invite-request` exists and accepts the admin's JWT. The internal portal's clients pages simply don't have a button that calls it.

**Fix:**
1. Add "Invite to Portal" button to client list rows and/or client detail page.
2. On click → modal confirming the email → POST → success toast.

**Files:**
- `apps/internal/src/app/clients/page.tsx` and/or `apps/internal/src/app/clients/[id]/page.tsx`

**Plan phase:** Phase 9

---

### ISSUE 8 — No role colour-coding in employee list (P2)

**Symptom:** The feature list specifies "Role colour-coding (admin, manager, editor, designer, developer)" but all roles display identically — same grey badge, same font weight.

**Root cause:** No role colour map exists. Role names are rendered as bare text or a generic badge.

**Fix:**
1. Create `lib/role-colors.ts` with a `ROLE_COLORS` map.
2. Apply coloured badge in employee list and employee detail tabs.

**Files:**
- `apps/internal/src/lib/role-colors.ts` — new file
- [apps/internal/src/app/employees/page.tsx](../apps/internal/src/app/employees/page.tsx)
- [apps/internal/src/app/employees/[id]/page.tsx](../apps/internal/src/app/employees/%5Bid%5D/page.tsx)

**Plan phase:** Phase 8a

---

### ISSUE 9 — No loading.tsx in any route folder (P2)

**Symptom:** Slow connection or initial load → blank white screen on every page until SWR resolves. Next.js App Router supports `loading.tsx` files for Suspense-based skeletons — none are present.

**Root cause:** No `loading.tsx` files created during the initial build.

**Fix:** Create `loading.tsx` in all 22+ route folders (see Phase 8b in plan).

**Plan phase:** Phase 8b

---

### ISSUE 10 — Analytics sub-pages and report pages unverified (P1)

**Symptom:** Unknown — `/analytics/content`, `/analytics/tasks`, `/reports/leaderboard`, `/reports/[employeeId]` were not fully inspected. They could be partially wired or placeholder-only.

**Root cause:** Audit scope didn't fully read these files.

**Fix:**
1. Read all four pages fully.
2. Verify each calls the correct hook → correct API endpoint.
3. Fix any envelope unwrap issues (same class of bug as client portal ERR-001/ERR-002 — `apiFetch` returns `{success, data}` envelope; hooks must unwrap `.data`).

**Files:**
- `apps/internal/src/app/analytics/content/page.tsx`
- `apps/internal/src/app/analytics/tasks/page.tsx`
- `apps/internal/src/app/reports/leaderboard/page.tsx`
- `apps/internal/src/app/reports/[employeeId]/page.tsx`

**Plan phase:** Phase 10

---

### ISSUE 11 — Null safety on review.reviewer field (P3)

**Symptom:** If a reviewer's account is deleted or the relation is null, `review.reviewer?.name` resolves to `undefined` — the display reads "by · 1 Jan 2026" with no name, confusing the admin.

**Fix:** Replace `{review.reviewer?.name}` with `{review.reviewer?.name ?? "Unknown Reviewer"}`.

**Files:**
- [apps/internal/src/app/employees/[id]/page.tsx](../apps/internal/src/app/employees/%5Bid%5D/page.tsx) — reviews tab

**Plan phase:** Phase 8 (cleanup sweep)

---

## Summary table

| # | Issue | User-visible symptom | Severity | Status |
|---|---|---|---|---|
| 1 | Pending employees route not reachable | Approval queue never loads | P0 | ✅ Resolved — commit f92e1a1 |
| 2 | No admin creation or invite flow | Can't add new admins without DB access | P0 | ✅ Resolved — commit f92e1a1 |
| 3 | Profile data read-only | Can't fix bank/ID/contact errors | P1 | ✅ Resolved — commit f92e1a1 |
| 4 | Attendance locked to current month | Can't review past months or specific employees | P1 | ✅ Resolved — commit f92e1a1 |
| 5 | No manual attendance entry | Can't correct missed check-ins | P2 | ✅ Resolved — commit f92e1a1 |
| 6 | No task reassignment UI | Can't change task assignee from detail view | P2 | ✅ Resolved — commit f92e1a1 |
| 7 | No client invite button | Must use API directly to invite clients | P1 | ✅ Resolved — commit f92e1a1 |
| 8 | No role colour-coding | All roles look identical in employee list | P2 | ✅ Resolved — commit 9ee3592 (role-colors.ts + employees/page.tsx + employees/[id]/page.tsx) |
| 9 | No loading skeletons | Blank screens on slow connections | P2 | ✅ Resolved — 22 loading.tsx files created |
| 10 | Analytics sub-pages unverified | May be placeholders or have envelope bugs | P1 | ✅ Verified fully wired — no fixes needed |
| 11 | Null safety on reviewer name | Confusing "by · date" display when reviewer deleted | P3 | ✅ Resolved — commit f92e1a1 |
| 12 | `reports/[employeeId]` crashes with runtime error | "An unsupported type was passed to use()" on page load | P0 | ✅ Resolved — commit dad9b5f (removed React.use() wrapper) |
| 13 | No user deletion capability | Admins cannot remove employees or clients from the system | P1 | ✅ Resolved — commit dad9b5f (DELETE /admin/users/:id, DELETE /admin/clients/:id, role-gated UI) |
| 14 | No role assignment UI | Cannot change employee roles from the portal | P1 | ✅ Resolved — commit dad9b5f (PUT /admin/users/:id/roles + RoleManager component) |
| 15 | Project end date allows invalid values | Can create a project where endDate < startDate | P2 | ✅ Resolved — commit dad9b5f (client-side + server-side validation) |
| 16 | Client portal shows no projects by default | "active" default filter hides newly assigned projects | P2 | ✅ Resolved — commit dad9b5f (default changed to "all", improved empty state) |
| 17 | No broadcast announcement capability | Admins cannot mass-message all employees from the portal | P1 | ✅ Resolved — commit 1e92b20 |
| 18 | Notifications not expandable (internal portal) | Clicking a notification only marks it read; full message never visible | P1 | ✅ Resolved — commit 1e92b20 |
| 19 | Notifications not expandable (HR/employee portal) | Same — clicking already-read notifications did nothing at all | P1 | ✅ Resolved — commit 1e92b20 |

---

## Issue 17 — No broadcast announcement to all employees (P1)

**Symptom:** Admin/Super Admin has no way to send a message to all current (and future) employees simultaneously. Communication must go through individual DMs, email clients, or direct DB calls.

**Root cause:**
- No `POST /admin/announcements` endpoint exists.
- No `Announcement` model in the schema.
- No broadcast service function that fans out to all active employees.
- No UI in the internal portal to compose and send an announcement.
- The `NotificationType` enum in `schema.prisma` does not include `ANNOUNCEMENT`.

**Fix — four-part implementation:**

### Part A — Schema
Add `ANNOUNCEMENT` to `NotificationType` enum and add an `Announcement` model to track sent broadcasts (for history + idempotency):

```prisma
// In NotificationType enum — add:
ANNOUNCEMENT

// New model:
model Announcement {
  id          String    @id @default(uuid())
  title       String
  message     String    @db.Text
  sentById    String
  recipientCount Int    @default(0)
  createdAt   DateTime  @default(now())

  sentBy      User      @relation(fields: [sentById], references: [id])

  @@map("announcements")
}
```

### Part B — API
**New endpoint** — `apps/api/src/routes/admin-features.routes.ts`:
```
POST /v1/admin/announcements
body: { title: string, message: string }
auth: authenticate + requireAdminRole (Admin or Super Admin only)
```

**New service** — `apps/api/src/services/announcement.service.ts`:
```typescript
async function broadcastAnnouncement(sentById: string, title: string, message: string)
```
1. Query all active, non-deleted employees: `User.findMany({ where: { status: "ACTIVE", deletedAt: null } })`.
2. `prisma.notification.createMany()` — one `ANNOUNCEMENT` notification per employee, with `{ title, message }`.
3. Fire-and-forget email loop: `sendEmail({ to: user.email, ... })` for each employee using a new `announcementEmailHtml()` template in `email.service.ts`.
4. Persist one `Announcement` row with `recipientCount`.
5. Return `{ recipientCount, announcementId }`.

**Optional GET endpoint** (announcement history):
```
GET /v1/admin/announcements   — paginated list of past announcements
```

### Part C — Frontend
**New page** — `apps/internal/src/app/announcements/page.tsx`:
- Header: "Announcements" with a "New Announcement" button.
- History table: past broadcasts (title, sent by, recipient count, date) via `useAnnouncements()` SWR hook.
- "New Announcement" → opens `AnnouncementModal` (same modal pattern used throughout).

**`AnnouncementModal` component:**
- Title field (required, max 120 chars).
- Message textarea (required, max 2000 chars).
- Character counter.
- "Preview Email" toggle (renders a read-only preview of the email template).
- "Send to All Employees" button → POST → success toast: "Announcement sent to N employees".
- Guard: confirm dialog before send — "This will notify all X active employees. Continue?"

**New SWR hook** — `apps/internal/src/lib/hooks/use-announcements.ts`:
```typescript
export function useAnnouncements() { ... }  // GET /admin/announcements
```

**Sidebar navigation** — add "Announcements" entry to `apps/internal/src/components/sidebar.tsx` (under the Communications section or between Reports and Notifications).

**Loading state** — `apps/internal/src/app/announcements/loading.tsx`.

### Part D — Email template
Add `announcementEmailHtml(senderName, title, message, portalUrl)` to `apps/api/src/services/email.service.ts`.
Design: branded header, announcement title as heading, full message body, "Open Portal" CTA button — matching existing brand colours (`#1A1A1A`, `#F5D547`).

**Files to create/edit:**
- `packages/db/prisma/schema.prisma` — `ANNOUNCEMENT` enum value + `Announcement` model
- `apps/api/src/services/announcement.service.ts` — new file
- `apps/api/src/services/email.service.ts` — add `announcementEmailHtml()`
- `apps/api/src/routes/admin-features.routes.ts` — add `POST /admin/announcements`, `GET /admin/announcements`
- `apps/internal/src/app/announcements/page.tsx` — new page
- `apps/internal/src/app/announcements/loading.tsx` — new loading state
- `apps/internal/src/lib/hooks/use-announcements.ts` — new SWR hook
- `apps/internal/src/components/sidebar.tsx` — add navigation entry

**Plan phase:** Wave 9 — ✅ Resolved commit 1e92b20

---

### ISSUE 18 — Notifications not expandable — internal portal (P1)

**Symptom:** Clicking a notification in the admin portal bell only called `markAsRead`. The full message was never visible — truncated to two lines with no expand affordance. Already-read notifications had `onClick` gated by `!n.read`, making them completely unclickable.

**Root cause:** The dropdown rendered a flat list where `onClick` was `() => { if (!n.read) markOneRead(n.id); }` — no detail state, no full-message view.

**Fix:** Added `selectedNotif` state to `top-nav.tsx`. Clicking any notification (read or unread) sets `selectedNotif` and switches the dropdown to a detail panel showing full title, full `whitespace-pre-wrap` message, and formatted timestamp. Back chevron returns to list. Unread notifications auto-marked read on open. Chevron `>` affordance added to every list row.

**Files:** [apps/internal/src/components/top-nav.tsx](../apps/internal/src/components/top-nav.tsx)

**Plan phase:** Wave 9 — ✅ Resolved commit 1e92b20

---

### ISSUE 19 — Notifications not expandable — HR/employee portal (P1)

**Symptom:** Same as Issue 18 but in `apps/hr`. `onClick` was `() => !notif.read && handleMarkRead(notif.id)` — clicking a read notification did nothing. No way to re-read a notification or see long messages.

**Root cause:** `notification-bell.tsx` had no detail state or expand mechanism.

**Fix:** Rewrote `notification-bell.tsx` with the same `selectedNotif` detail-panel pattern. All notifications always clickable. Added `BellOff` and `CheckCheck` imports. `timeAgo()` helper added (consistent with internal portal).

**Files:** [apps/hr/src/components/notification-bell.tsx](../apps/hr/src/components/notification-bell.tsx)

**Plan phase:** Wave 9 — ✅ Resolved commit 1e92b20

---

## Remediation plan — wave order

### Wave 0 — Backend route fix (Issue 1)
Verify route mounting in `index.ts`; fix the pending-employee approval endpoint. Unblocks the only P0 functional breakage. ~30 min.

### Wave 1 — Admin user management (Issue 2)
Add `POST /admin/users/create`, `POST /admin/users/invite`, `POST /admin/users/accept-invite` endpoints + schema `AdminInvite` model + frontend pages. ~1 day.

### Wave 2 — Profile data edit (Issue 3)
Add PUT endpoint + edit mode in employee detail. ~half day.

### Wave 3 — Attendance improvements (Issues 4, 5)
Month/year picker + employee filter + manual entry modal. ~half day.

### Wave 4 — Task & content improvements (Issue 6)
Task reassignment dropdown + content comments verification. ~2 hours.

### Wave 5 — Cross-portal integration (Issue 7)
Client invite button in internal portal. ~1 hour.

### Wave 6 — Analytics & reports verification (Issue 10)
Read and fix all four sub-pages. ~half day.

### Wave 7 — UI polish & loading states (Issues 8, 9, 11)
Role colours, loading.tsx files, null safety. ~half day.

---

### Wave 9 — Broadcast announcements + notification detail view (Issues 17–19, commit 1e92b20)

1. **Issue 17:** Schema `ANNOUNCEMENT` enum + `Announcement` model. `broadcastAnnouncement()` service fans out `notification.createMany()` to all active employees and fires per-employee emails via `Promise.allSettled` (non-blocking). `POST /admin/announcements` + `GET /admin/announcements` behind `requireAdminRole`. `/announcements` page with history table + `AnnouncementModal`. Dashboard dark broadcast CTA banner with inline `QuickAnnounceModal` + last-sent preview. `Announce` nav pill in top-nav.

2. **Issue 18 (internal portal):** `top-nav.tsx` — clicking any notification (read or unread) now opens an inline detail panel showing full title, full message, and formatted timestamp. Back chevron returns to list. Unread notifications auto-marked read on open. Chevron affordance on every list row.

3. **Issue 19 (HR/employee portal):** `notification-bell.tsx` — same detail-view fix. Previously, clicking already-read notifications did nothing (`onClick` gated by `!notif.read`). Now all notifications are always clickable. Full `whitespace-pre-wrap` message body in detail panel.

---

### Wave 8 — Bug fixes & new capabilities (Issues 12–16, commit dad9b5f)

1. **Issue 12:** `reports/[employeeId]` crash — `React.use(params)` is not supported in this Next.js version; replaced with direct destructuring.
2. **Issue 13:** User deletion — `DELETE /admin/users/:id` (soft-delete via `deletedAt` + `status=INACTIVE`) and `DELETE /admin/clients/:id`. Both require caller to have "Admin" or "Super Admin" role. Super Admin protection: non-super-admins cannot delete super admins. Self-deletion blocked.
3. **Issue 14:** Role management — `PUT /admin/users/:id/roles` atomically replaces all roles (transaction: delete existing + createMany). `RoleManager` component in employee detail Profile tab shows toggle buttons for all system roles; visible only to admins/super-admins.
4. **Issue 15:** Project date validation — enforced at both client (min attr + onSubmit check, clears endDate when startDate advances past it) and server (`createProject` + `updateProject`).
5. **Issue 16:** Client portal projects — default filter changed from "active" to "all" so newly assigned projects are always visible regardless of status; empty state message now distinguishes "no projects at all" vs "no matching filter".

---

## Decisions (open)

1. **Admin invite vs direct create:** Resolved — both supported as of commit f92e1a1.
2. **Attendance override scope:** Resolved — any user with `attendance:edit` permission.
3. **Profile data edit scope:** Resolved — all fields editable, changes visible in audit log via existing `auditLog` middleware.

---

## Out of scope for this audit
- HR portal (`apps/hr`) — separate audit needed.
- Jobs portal (`apps/jobs`) — public-facing, separate audit.
- Performance / caching strategy beyond what SWR already provides.
- E2E test coverage (worth adding after Wave 1 lands).
- Prisma migration history (project uses `db push`).
