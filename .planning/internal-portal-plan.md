# Internal Admin Portal — Implementation Plan

**Scope:** Close all feature gaps in `apps/internal`, wire real API data end-to-end, add missing backend endpoints, and ensure every feature in the feature list works correctly — including correct integration with the client portal and future HR/Jobs portals.
**Branch convention:** work off `main`; one PR per phase.
**Current user:** `tabish@dashmani.com` — seeded as Super Admin with all permissions.
**Status as of 2026-05-16:** All 10 original phases complete. Wave 8 (new bugs) resolved. Wave 9 (broadcast announcements + notification detail view) resolved — commit 1e92b20. UI/UX polish (design-spec parity) complete — branch docs/design-critique.

---

## Audit Summary

### What already works (do not touch)
- Login page + auth flow (`/login`, `layout.tsx`, `lib/auth.ts`, `lib/api.ts`)
- Dashboard stats via `useOverviewStats()` → `GET /analytics/overview`
- Employee directory with search + status filter (`/employees`)
- Add new employee form (`/employees/new`)
- Employee detail — 8-tab view: overview, profile data, documents, performance, accounts, devices, tasks, reviews (`/employees/[id]`)
- Employee performance analytics page (`/employees/[id]/performance`)
- Pending employee onboarding approvals (`/employees/pending`) — but see G1 below
- Teams hierarchy with create/delete/assign (`/teams`)
- Tasks — Kanban + list views, status updates, comments (`/tasks`, `/tasks/[id]`)
- Content list + calendar views (`/content`, `/content/calendar`)
- Create/edit content (`/content/new`, `/content/[id]`)
- Social accounts CRUD, bulk import, platform filter (`/accounts`)
- Workload matrix (`/workload`)
- Clients list + create (`/clients`, `/clients/new`)
- Projects list + create + detail (`/projects`, `/projects/new`, `/projects/[id]`)
- Attendance records view with `AttendanceClock` component (`/attendance`)
- Analytics overview + tabs (`/analytics`, `/analytics/content`, `/analytics/tasks`)
- Approvals: documents, profile pictures, leave requests (`/approvals`)
- AI assistant 6-tab hub (`/ai-assistant`)
- Expenses approve/reject (`/expenses`)
- Holidays CRUD + year filter (`/holidays`)
- Jobs + applications workflow (`/jobs`)
- Salary slips + bulk generation + approval (`/salary-slips`)
- Offer letters generate + list (`/offer-letters`)
- Devices inventory — assign, return, edit, delete (`/devices`)
- Auto-teams detection + creation (`/auto-teams`)
- Internships workflow (`/internships`)
- Complaints respond + status (`/complaints`)
- Bug reports status management (`/bug-reports`)
- Reports + leaderboard (`/reports`, `/reports/leaderboard`, `/reports/[employeeId]`)
- Notifications system (`GET /admin/notifications`, mark read)
- Role management API (`/roles`)
- Component library: `top-nav.tsx`, `sidebar.tsx`, `task-card.tsx`, `task-form.tsx`, `content-form.tsx`, `account-form.tsx`, `employee-form.tsx`, `attendance-clock.tsx`, `link-preview-card.tsx`

### Gaps to close (this plan)
| # | Gap | Effort |
|---|-----|--------|
| G1 | `/admin/employees/pending` endpoint is in `admin-reports.routes.ts` but not mounted — frontend 404s | S |
| G2 | No admin invite / self-signup flow — new admins can only be added via DB seed | M |
| G3 | Employee profile data (`bankDetails`, `familyContact`, Aadhaar, PAN) is read-only — no edit UI or PUT endpoint | M |
| G4 | Attendance page has no date-range picker — always shows current month only | S |
| G5 | Attendance: no admin manual entry / override capability | M |
| G6 | Task detail has no reassign UI — no PUT `/tasks/:id/assignee` endpoint | S |
| G7 | `tasks/new/page.tsx` and `accounts/new/page.tsx`, `clients/new/page.tsx`, `projects/new/page.tsx` not fully verified — need inspection and any gap fixes | S |
| G8 | No bulk actions in Approvals (documents, profile pics, leave requests) | M |
| G9 | Analytics pages (`/analytics/content`, `/analytics/tasks`) — need to verify they are fully wired to API and not placeholders | S |
| G10 | Reports: `/reports/leaderboard` and `/reports/[employeeId]` — need to verify full implementation | S |
| G11 | No role colour-coding in employee directory list (roles shown as text, not coloured badges) | S |
| G12 | UI consistency audit — hardcoded hex colours, missing `Topstrip`/page-header pattern consistency, no `loading.tsx` / `error.tsx` in any route folder | M |
| G13 | Client portal integration: `POST /v1/client/auth/invite-request` requires admin auth — no UI in internal portal for sending client invites | M |
| G14 | No "Add Admin" page in UI — super admins need a way to create other internal users directly (not via HR self-register flow) | M |
| G15 | Task comments are wired on task detail but content post comments integration with internal portal needs verification | S |
| G16 | Social accounts bulk import (`/accounts/import`) — needs verification that the file upload UI and API are fully wired | S |

---

## UI/UX Polish — Design-Spec Parity (2026-05-16)

**Source:** Internal Portal v1.html prototype (claude.ai/design, exported bundle).  
**Goal:** Close UI/UX gaps between the built portal and the design prototype without touching functionality.

### Changes made

| File | Change |
|---|---|
| `apps/internal/src/components/command-palette.tsx` (new) | Ctrl+K / Cmd+K search modal — all 26 pages/tools, ↑↓/Enter/Esc keyboard nav, grouped results (Pages vs Tools), Quick navigation empty state, keyboard hint footer |
| `apps/internal/src/components/sidebar.tsx` | More section: flat expand → 3-col icon-above/label-below grid in cream `#F3EED8` inset panel with "All Features" header. Item count badge on toggle. `moreOpen` persisted to localStorage. Active item: indigo bg + white text. Primary nav items now carry group labels (People / Work / Business / Ops) rendered as section dividers. |
| `apps/internal/src/components/top-nav.tsx` | Search button added (Search icon + `⌘K` kbd hint, `btn-3d` style) before Announce; accepts `onOpenSearch?: () => void` prop |
| `apps/internal/src/app/layout.tsx` | Global `keydown` listener for Ctrl+K / Cmd+K; `CommandPalette` mounted at root; `cmdOpen` state; passes `onOpenSearch` to TopNav |

### Design decisions
- More grid uses `grid-cols-3` with `wordBreak: break-word` on labels — no truncation regardless of label length.
- Collapsed rail: More button shows `LayoutGrid` icon with tooltip; clicking navigates to `/ai-assistant` (first More item) as per design.
- Command palette Esc closes via both `keydown` on `window` (layout) and local `onKeyDown` inside the input.

---

## Phase 1 — Fix Critical Backend Gap (G1)

**Goal:** Make `/admin/employees/pending`, `/admin/employees/:id/approve`, and `/admin/employees/:id/reject` reachable.

**Root cause:** These routes are defined in `admin-reports.routes.ts` but the route file may not be mounted correctly, or the route order causes it to collide with `admin-features.routes.ts`. Verify by reading `apps/api/src/routes/index.ts`.

**Tasks:**

### 1a — Verify route mounting
Read `apps/api/src/routes/index.ts`. Confirm `admin-reports.routes.ts` is imported and mounted at the correct prefix. If missing, add:
```typescript
import adminReportsRouter from "./admin-reports.routes";
router.use(adminReportsRouter);
```

### 1b — Verify endpoint reachability
Smoke test:
```bash
curl -H "Authorization: Bearer <token>" http://localhost:4000/v1/admin/employees/pending
```
Expected: 200 with array of users with `status: "ONBOARDING"`.

### 1c — Fix any collisions
If `/admin/employees/pending` is shadowed by `/admin/employees/:id/...` dynamic routes in `admin-features.routes.ts`, reorder so static paths (`/pending`) come before dynamic paths (`/:id`).

**Verification:**
- `/employees/pending` page in internal portal loads real data
- Approve / Reject buttons work and employee moves out of pending list

---

## Phase 2 — Admin User Management (G2, G14)

**Goal:** Super admins can create internal users directly and invite new admins without touching the DB.

### 2a — Add admin user creation endpoint

**New endpoint** — `apps/api/src/routes/admin-features.routes.ts`:
```
POST /v1/admin/users/create
body: { name, email, password, roleIds: string[], designation?, salary? }
```
Protected by `authenticate` + `requirePermission("employees", "create")`.

**Service** — `apps/api/src/services/employee.service.ts`, add:
```typescript
createAdminUser(data: CreateAdminUserDto): Promise<User>
// Creates user with status="ACTIVE" (bypass ONBOARDING), assigns roles, sends welcome email
```

### 2b — Add admin invite endpoint (invite by email)

**New endpoint**:
```
POST /v1/admin/users/invite
body: { email, roleIds: string[], designation? }
```
Creates an `AdminInvite` row (or reuse `ClientInvite` pattern from client portal — add a `type` field or a new `AdminInvite` model to schema).
Sends email with `/admin-signup?token=<uuid>` link.

**Schema addition** — `packages/db/prisma/schema.prisma`:
```prisma
model AdminInvite {
  id        String    @id @default(uuid())
  email     String    @unique
  token     String    @unique @default(uuid())
  roleIds   String[]
  expiresAt DateTime  @map("expires_at")
  usedAt    DateTime? @map("used_at")
  createdAt DateTime  @default(now())
}
```

### 2c — Admin signup page (`/admin-signup`)

**File to create:** `apps/internal/src/app/admin-signup/page.tsx`

URL pattern: `/admin-signup?token=<uuid>`

UI (match login page style):
1. No token → "Invalid invite link" with back-to-login link
2. Token present → Name, Password, Confirm Password form
3. Submit → `POST /v1/admin/users/accept-invite` with `{ token, name, password }`
4. On success → store tokens → redirect to `/dashboard`

### 2d — "Add Admin User" page in internal portal

**File to create:** `apps/internal/src/app/employees/add-admin/page.tsx`

Linked from the Employees section (or Settings). Form: Name, Email, Password (optional — can force set or send invite), Role(s), Designation.

### 2e — Update layout auth guard

`apps/internal/src/app/layout.tsx` — add `/admin-signup` to bypass list:
```typescript
const publicRoutes = ["/login", "/admin-signup"];
```

**Verification:**
- Super admin can navigate to `/employees/add-admin` → create a user → user can log in
- Super admin can send invite email → recipient follows link → completes signup → can log in
- New admin cannot access the portal until they complete signup

---

## Phase 3 — Employee Profile Data Edit (G3)

**Goal:** Admins can view AND edit employee-submitted profile data (bank details, contacts, ID proofs).

### 3a — Add PUT endpoint

**New endpoint** — `apps/api/src/routes/admin-reports.routes.ts` (or `admin-features.routes.ts`):
```
PUT /v1/admin/employees/:id/profile-data
body: { bankName?, bankAccountNumber?, ifscCode?, panNumber?, aadhaarNumber?,
        familyContact1Name?, familyContact1Phone?, familyContact2Name?, familyContact2Phone?,
        mailingAddress? }
```
Protected by `authenticate` + `requirePermission("employees", "edit")`.

**Service** — `apps/api/src/services/employee-profile.service.ts`, add:
```typescript
updateEmployeeProfileData(userId: string, data: UpdateProfileDataDto): Promise<EmployeeProfile>
```

### 3b — Edit UI in employee detail page

**File to edit:** `apps/internal/src/app/employees/[id]/page.tsx`

In the "Employee Submitted Data" tab (currently read-only):
- Add `isEditingProfile` state
- Add Edit button (pencil icon) that switches from read-only `InfoField` grid to an editable form
- On save → `PUT /admin/employees/:id/profile-data` → `mutate` the profile SWR key

**Verification:**
- Admin opens employee detail → Profile Data tab → clicks Edit → modifies bank details → saves → reads back updated values

---

## Phase 4 — Attendance Improvements (G4, G5)

**Goal:** Admin can view any month's attendance and manually enter/override records.

### 4a — Month/year picker in attendance page

**File to edit:** `apps/internal/src/app/attendance/page.tsx`

Current: hardcoded to current month.
Add:
```typescript
const [viewYear, setViewYear] = useState(now.getFullYear());
const [viewMonth, setViewMonth] = useState(now.getMonth()); // 0-indexed
```
Replace hardcoded `startDate`/`endDate` with derived values from `viewYear`/`viewMonth`.
Add `< Month Year >` navigation controls (same chevron pattern as content calendar).

Also add an employee filter dropdown (pull from `useEmployees()`) so admin can view a specific employee's attendance.

### 4b — Admin manual attendance entry

**New endpoint** — `apps/api/src/routes/attendance.routes.ts`:
```
POST /v1/attendance/manual
body: { userId, date, checkIn?, checkOut?, status }
PUT  /v1/attendance/:id/override
body: { checkIn?, checkOut?, status, note? }
```
Protected by `authenticate` + `requirePermission("attendance", "edit")`.

**Service** — `apps/api/src/services/attendance.service.ts`, add:
```typescript
createManualRecord(data: ManualAttendanceDto): Promise<Attendance>
overrideAttendanceRecord(id: string, data: OverrideAttendanceDto): Promise<Attendance>
```

### 4c — Manual entry UI

**File to edit:** `apps/internal/src/app/attendance/page.tsx`

Add "+ Add Record" button → modal with:
- Employee picker
- Date picker
- Status dropdown (PRESENT / LATE / ABSENT / HALF_DAY / LEAVE)
- Check-in time (optional)
- Check-out time (optional)
- Note

Each row in the attendance table gets an edit (pencil) icon → same modal pre-filled for override.

**Verification:**
- Admin navigates to previous month → correct records shown
- Admin adds manual record for an employee → appears in table
- Admin edits existing record → changes persist after page refresh

---

## Phase 5 — Task & Content Improvements (G6, G15)

**Goal:** Admins can reassign tasks; content post comments are verified working in internal portal.

### 5a — Task reassignment endpoint

**Edit endpoint** — `apps/api/src/routes/task.routes.ts`, extend `PUT /tasks/:id` handler to accept `assigneeId` as a valid update field (it likely already supports it — verify). If not, add:
```
PATCH /v1/tasks/:id/assignee
body: { assigneeId: string }
```

### 5b — Task reassignment UI

**File to edit:** `apps/internal/src/app/tasks/[id]/page.tsx`

In the task detail header area (where assignee is shown):
- Replace static assignee display with a dropdown of employees
- On change → `PATCH /tasks/:id/assignee` or include in existing `PUT /tasks/:id`
- Mutate SWR after success

### 5c — Content post comments (internal portal)

**Verify** `apps/internal/src/app/content/[id]/page.tsx` reads `GET /content/:id/comments` and POSTs to `POST /content/:id/comments`.
These endpoints exist in `content.routes.ts`. If the page doesn't use them, wire them using the same `useClientPostComments` pattern from the client portal (adapting the hook to internal auth).

**Verification:**
- Task detail shows assignee dropdown — change assignee → persists after refresh
- Content detail shows comment thread — submit comment → appears without page reload

---

## Phase 6 — New Form Pages Verification & Fix (G7)

**Goal:** Confirm `tasks/new`, `accounts/new`, `clients/new`, `projects/new` are fully implemented and fix any gaps.

### 6a — Audit each form page
For each of the four pages:
1. Read full file
2. Confirm it submits to the correct API endpoint
3. Confirm required fields match API validator schema in `packages/shared/src/validators/`
4. Confirm redirect after success goes to the correct list or detail page
5. Fix any mismatches found

### 6b — Accounts bulk import verification

**File:** `apps/internal/src/app/accounts/import/page.tsx`

Verify:
- File upload uses `apiUpload()` (not `apiFetch()`) for multipart/form-data
- Calls `POST /admin/accounts/import`
- Shows success count + error list from response
- "Download Template" button calls `GET /admin/accounts/import/template`

**Verification:**
- Each new-item form submits successfully and redirects correctly
- Accounts import: upload valid Excel → success message; upload malformed file → error message

---

## Phase 7 — Approvals Bulk Actions (G8)

**Goal:** Admin can approve or reject multiple items at once.

### 7a — Bulk approve/reject endpoints

**New endpoints** — `apps/api/src/routes/admin-features.routes.ts`:
```
POST /v1/admin/documents/bulk-review      body: { ids: string[], action: "APPROVE"|"REJECT", note? }
POST /v1/admin/profile-pictures/bulk-review  body: { ids: string[], action: "APPROVE"|"REJECT" }
POST /v1/admin/leave-requests/bulk         body: { ids: string[], action: "APPROVE"|"REJECT", note? }
```

### 7b — Bulk actions UI

**File to edit:** `apps/internal/src/app/approvals/page.tsx`

For each tab (Documents, Profile Pictures, Leave Requests):
- Add checkboxes on each row
- "Select All" checkbox in header
- Bulk action bar appears when ≥1 items selected: "Approve Selected" / "Reject Selected" buttons
- On action → call bulk endpoint → mutate SWR keys

**Verification:**
- Select 3 documents → "Approve Selected" → all 3 move out of pending
- Select all leave requests → "Reject Selected" → all rejected with optional note

---

## Phase 8 — Role Colour-Coding & UI Consistency (G11, G12)

**Goal:** Role badges are colour-coded; all pages have consistent loading/error states.

### 8a — Role colour map

**Add to** `apps/internal/src/components/` a shared helper or to `apps/internal/src/lib/role-colors.ts`:
```typescript
export const ROLE_COLORS: Record<string, { bg: string; text: string }> = {
  "Super Admin": { bg: "bg-red-100",    text: "text-red-700" },
  "Admin":       { bg: "bg-orange-100", text: "text-orange-700" },
  "Manager":     { bg: "bg-blue-100",   text: "text-blue-700" },
  "Editor":      { bg: "bg-purple-100", text: "text-purple-700" },
  "Designer":    { bg: "bg-pink-100",   text: "text-pink-700" },
  "Developer":   { bg: "bg-green-100",  text: "text-green-700" },
};
export function getRoleColor(roleName: string) {
  return ROLE_COLORS[roleName] ?? { bg: "bg-gray-100", text: "text-gray-700" };
}
```

Apply in:
- `apps/internal/src/app/employees/page.tsx` — role badges on each employee row
- `apps/internal/src/app/employees/[id]/page.tsx` — role chips in overview tab

### 8b — Loading states

Create `loading.tsx` in each route folder that lacks one:
```
apps/internal/src/app/dashboard/loading.tsx
apps/internal/src/app/employees/loading.tsx
apps/internal/src/app/tasks/loading.tsx
apps/internal/src/app/content/loading.tsx
apps/internal/src/app/accounts/loading.tsx
apps/internal/src/app/projects/loading.tsx
apps/internal/src/app/attendance/loading.tsx
apps/internal/src/app/analytics/loading.tsx
apps/internal/src/app/approvals/loading.tsx
apps/internal/src/app/devices/loading.tsx
apps/internal/src/app/holidays/loading.tsx
apps/internal/src/app/expenses/loading.tsx
apps/internal/src/app/complaints/loading.tsx
apps/internal/src/app/bug-reports/loading.tsx
apps/internal/src/app/reports/loading.tsx
apps/internal/src/app/jobs/loading.tsx
apps/internal/src/app/salary-slips/loading.tsx
apps/internal/src/app/offer-letters/loading.tsx
apps/internal/src/app/internships/loading.tsx
apps/internal/src/app/auto-teams/loading.tsx
apps/internal/src/app/ai-assistant/loading.tsx
apps/internal/src/app/workload/loading.tsx
```

Pattern:
```tsx
export default function Loading() {
  return (
    <div className="p-6 space-y-4">
      <div className="h-8 w-48 bg-gray-200 rounded animate-pulse" />
      <div className="grid grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-24 bg-gray-100 rounded-lg animate-pulse" />
        ))}
      </div>
      <div className="h-64 bg-gray-100 rounded-lg animate-pulse" />
    </div>
  );
}
```

### 8c — Remove hardcoded hex colours

Audit `globals.css` and high-traffic page files. Replace:
- `#F5D547` → `bg-[#F5D547]` already in Tailwind config — check if token `bg-brand-yellow` or similar exists; if not, add to `tailwind.config.ts`
- `#FDF6E3` → `bg-cream` token (or match `bg-bg` from client portal Tailwind config)
- `#1A1A1A` → `text-gray-900` or existing token

**Verification:**
- Employee list shows coloured role badges
- Throttle network → loading skeletons appear on all pages
- Kill API → pages show error state (not blank screen)

---

## Phase 9 — Client Portal Integration (G13)

**Goal:** Admin can send client invites from the internal portal without touching the API directly.

### 9a — "Invite Client" button in Clients section

**File to edit:** `apps/internal/src/app/clients/page.tsx` or `apps/internal/src/app/clients/[id]/page.tsx`

Add "Invite to Portal" button on each client row/detail:
- Opens a confirmation modal: "Send portal invite to {client.email}?"
- On confirm → `POST /v1/client/auth/invite-request` with `{ email: client.email }`
  - This endpoint already exists in `client.routes.ts` and requires `authenticate` + `requirePermission("clients","create")`
- Show success toast: "Invite sent to {email}"
- Show error if email already invited or client already registered

**Verification:**
- Admin opens client detail → "Invite to Portal" → confirm → client receives invite email
- Client follows link → `/signup?token=...` on client portal → completes signup → can log in

---

## Phase 10 — Analytics Verification & Fix (G9, G10)

**Goal:** Confirm all analytics sub-pages and report pages are fully wired.

### 10a — Audit analytics pages

Read `apps/internal/src/app/analytics/content/page.tsx` and `apps/internal/src/app/analytics/tasks/page.tsx` fully.
- Verify they call `useContentAnalytics()` / `useTaskAnalytics()` hooks
- Verify hooks call `GET /analytics/content` and `GET /analytics/tasks`
- Fix any envelope unwrap issues (same pattern as client portal ERR-001/ERR-002)

### 10b — Audit report pages

Read `apps/internal/src/app/reports/leaderboard/page.tsx` and `apps/internal/src/app/reports/[employeeId]/page.tsx`.
- Verify calls to `GET /admin/reports/leaderboard` and `GET /admin/reports/:reportId`
- Fix any gaps

### 10c — Add recharts to analytics pages if missing

If analytics sub-pages are placeholder/text-only:
```bash
npm install recharts -w @dashmani/internal
```
Add at minimum a `BarChart` for tasks by status and a `PieChart` for content by format, matching the pattern already implemented in `apps/client/src/app/analytics/page.tsx`.

**Verification:**
- All three analytics tabs render real charts
- Leaderboard page shows ranked employees with scores
- Employee report page shows performance breakdown

---

## Phase 11 — Wave 8 Bug Fixes (commit dad9b5f)

These issues were discovered post-launch and resolved together.

### 11a — Fix reports/[employeeId] crash
`React.use(params)` called with non-Promise — removed, replaced with direct destructure.

### 11b — User & client deletion
- `DELETE /admin/users/:id` — soft-delete (sets `deletedAt`, `status=INACTIVE`). Guards: self-delete blocked, non-super-admin cannot delete super admin.
- `DELETE /admin/clients/:id` — hard delete.
- Both gated by inline `requireAdminRole` middleware (checks JWT roles for "admin" or "super admin").
- Delete buttons added to employee detail header and client list rows, gated by caller role.

### 11c — Role assignment
- `PUT /admin/users/:id/roles` — atomically replaces all user roles (Prisma transaction).
- `RoleManager` component added to employee detail Profile tab — toggle-button list of all system roles, save via PUT endpoint. Visible to admin/super-admin only.

### 11d — Project date validation
- Client-side: `min` attr on end date field; `onSubmit` guard; start date change auto-clears invalid end date.
- Server-side: `createProject` and `updateProject` both throw `AppError(400)` if `endDate < startDate`.

### 11e — Client portal projects default tab
- Changed default from `"active"` to `"all"` so newly assigned projects are always visible.
- Improved empty state to distinguish zero projects vs filtered-out projects.

---

## Phase 12 — Broadcast Announcements (Wave 9, Issue 17)

**Goal:** Admin/Super Admin can compose a title + message and broadcast it to every active employee simultaneously — each recipient gets an in-app `ANNOUNCEMENT` notification (visible in their portal bell) and an email at their registered address.

---

### 12a — Schema changes

**File:** `packages/db/prisma/schema.prisma`

1. Add `ANNOUNCEMENT` to the `NotificationType` enum (after `GENERAL`).
2. Add a new `Announcement` model for broadcast history:

```prisma
model Announcement {
  id             String   @id @default(uuid())
  title          String
  message        String   @db.Text
  sentById       String
  recipientCount Int      @default(0)
  createdAt      DateTime @default(now())

  sentBy         User     @relation("AnnouncementsSent", fields: [sentById], references: [id])

  @@map("announcements")
}
```

3. Add the back-relation on `User`:
```prisma
announcementsSent Announcement[] @relation("AnnouncementsSent")
```

Run `npm run db:generate` then `npm run db:push` after editing.

---

### 12b — Announcement service

**New file:** `apps/api/src/services/announcement.service.ts`

```typescript
import { prisma } from "@dashmani/db";
import { sendEmail } from "./email.service";
import { announcementEmailHtml } from "./email.service";

export async function broadcastAnnouncement(
  sentById: string,
  title: string,
  message: string
): Promise<{ recipientCount: number; announcementId: string }> {
  // 1. Fetch all active employees (excludes deleted + inactive)
  const employees = await prisma.user.findMany({
    where: { status: "ACTIVE", deletedAt: null },
    select: { id: true, name: true, email: true },
  });

  if (employees.length === 0) {
    const record = await prisma.announcement.create({
      data: { title, message, sentById, recipientCount: 0 },
    });
    return { recipientCount: 0, announcementId: record.id };
  }

  // 2. Fan out in-app notifications in one batch
  await prisma.notification.createMany({
    data: employees.map((emp) => ({
      userId: emp.id,
      type: "ANNOUNCEMENT" as const,
      title,
      message,
    })),
  });

  // 3. Persist announcement record
  const sender = await prisma.user.findUnique({
    where: { id: sentById },
    select: { name: true },
  });
  const record = await prisma.announcement.create({
    data: { title, message, sentById, recipientCount: employees.length },
  });

  // 4. Fire-and-forget emails (non-blocking — log failures, never throw)
  const senderName = sender?.name ?? "Admin";
  const emailPromises = employees.map((emp) =>
    sendEmail({
      to: emp.email,
      subject: `[Announcement] ${title}`,
      html: announcementEmailHtml(senderName, title, message),
    }).catch((err) => console.error(`✉ Announcement email failed for ${emp.email}:`, err))
  );
  Promise.allSettled(emailPromises); // fire-and-forget

  return { recipientCount: employees.length, announcementId: record.id };
}

export async function getAnnouncements(page = 1, limit = 20) {
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    prisma.announcement.findMany({
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: { sentBy: { select: { name: true } } },
    }),
    prisma.announcement.count(),
  ]);
  return { items, total, page, limit };
}
```

---

### 12c — Email template addition

**File:** `apps/api/src/services/email.service.ts` — add exported function:

```typescript
export function announcementEmailHtml(senderName: string, title: string, message: string): string {
  const portalUrl = process.env.INTERNAL_APP_URL || "https://portal.digitalsukoon.com";
  return `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 0; background: #f5f5f5; }
    .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; overflow: hidden; }
    .header { background: linear-gradient(135deg, #1A1A1A, #333); color: #fff; padding: 24px 30px; }
    .header h1 { margin: 0; font-size: 20px; font-weight: 600; }
    .header p { margin: 6px 0 0; font-size: 13px; opacity: 0.7; }
    .body { padding: 28px 30px; }
    .badge { display: inline-block; background: #F5D547; color: #1A1A1A; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; margin-bottom: 16px; }
    .message-body { font-size: 15px; color: #333; line-height: 1.7; white-space: pre-wrap; }
    .action-btn { display: inline-block; background: #F5D547; color: #1A1A1A; padding: 10px 24px; border-radius: 20px; font-size: 13px; font-weight: 600; text-decoration: none; margin-top: 24px; }
    .footer { padding: 16px 30px; background: #f8f9fa; text-align: center; font-size: 11px; color: #999; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${title}</h1>
      <p>Announcement from ${senderName}</p>
    </div>
    <div class="body">
      <span class="badge">Announcement</span>
      <p class="message-body">${message.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}</p>
      <a href="${portalUrl}" class="action-btn">Open Portal →</a>
    </div>
    <div class="footer">Dashmani Media Private Limited · Digital Sukoon</div>
  </div>
</body>
</html>`;
}
```

---

### 12d — API routes

**File:** `apps/api/src/routes/admin-features.routes.ts` — add two new routes:

```typescript
import { broadcastAnnouncement, getAnnouncements } from "../services/announcement.service";

// POST /admin/announcements — broadcast to all active employees
router.post(
  "/admin/announcements",
  authenticate,
  requireAdminRole,  // existing inline middleware already in file
  async (req, res, next) => {
    try {
      const { title, message } = req.body;
      if (!title?.trim() || !message?.trim()) {
        return error(res, "VALIDATION_ERROR", "title and message are required", 400);
      }
      if (title.length > 120) {
        return error(res, "VALIDATION_ERROR", "title must be 120 characters or fewer", 400);
      }
      if (message.length > 2000) {
        return error(res, "VALIDATION_ERROR", "message must be 2000 characters or fewer", 400);
      }
      const result = await broadcastAnnouncement(req.user!.userId, title.trim(), message.trim());
      return success(res, result, 201);
    } catch (err) {
      next(err);
    }
  }
);

// GET /admin/announcements — paginated announcement history
router.get(
  "/admin/announcements",
  authenticate,
  requireAdminRole,
  async (req, res, next) => {
    try {
      const page = parseInt(String(req.query.page)) || 1;
      const limit = parseInt(String(req.query.limit)) || 20;
      const result = await getAnnouncements(page, limit);
      return success(res, result);
    } catch (err) {
      next(err);
    }
  }
);
```

---

### 12e — SWR hook

**New file:** `apps/internal/src/lib/hooks/use-announcements.ts`

```typescript
import useSWR from "swr";
import { apiFetch } from "../api";

export function useAnnouncements(page = 1) {
  const { data, error, isLoading, mutate } = useSWR(
    `/admin/announcements?page=${page}&limit=20`,
    (url) => apiFetch(url)
  );
  return {
    announcements: data?.data?.items ?? [],
    total: data?.data?.total ?? 0,
    isLoading,
    isError: !!error,
    mutate,
  };
}
```

---

### 12f — Frontend page

**New file:** `apps/internal/src/app/announcements/page.tsx`

Layout:
- Top bar: "Announcements" heading + "New Announcement" button (yellow, `requireAdminRole`-gated via caller role check).
- `AnnouncementModal` (inline component or separate file):
  - Title input (required, 120 char max with counter).
  - Message textarea (required, 2000 char max with counter, 6 rows).
  - Preview panel (collapsible) that renders the styled email HTML in an iframe or styled `div`.
  - Confirm guard before submit: `"This will notify all active employees. Continue?"` (browser `confirm()` or a simple secondary button state).
  - On submit → `POST /admin/announcements` → success toast: `"Announcement sent to ${n} employees"`.
- History table below (from `useAnnouncements()`):
  - Columns: Title | Sent by | Recipients | Date
  - Skeleton loading via `isLoading`.
  - Empty state: "No announcements sent yet."

**New file:** `apps/internal/src/app/announcements/loading.tsx` — standard pulse skeleton.

---

### 12g — Sidebar navigation entry

**File:** `apps/internal/src/components/sidebar.tsx`

Add "Announcements" link (e.g., megaphone icon from `lucide-react`) in the appropriate section — between Reports and AI Assistant, or under a "Communications" group if one exists.

---

### Verification

- Admin opens `/announcements` → sees empty history → clicks "New Announcement".
- Fills title + message → clicks send → confirm dialog → POST succeeds → toast confirms "Sent to N employees".
- New entry appears in history table with correct recipient count and timestamp.
- Any active employee logs into their portal → notification bell shows unread `ANNOUNCEMENT` notification with the exact title + message.
- Employee's email inbox receives a branded email with the announcement content and "Open Portal" button.
- Non-admin user role: "New Announcement" button is hidden or disabled.

---

## Execution Order

```
Phase 1  → Phase 2  → Phase 3 → Phase 4 → Phase 5
(backend)   (admin)    (profile)  (attend)   (tasks)
               ↓
Phase 6  → Phase 7  → Phase 8 → Phase 9 → Phase 10 → Phase 11 → Phase 12
(forms)    (bulk)     (UI/UX)   (client)   (analytics)  (wave 8)   (announce)
```

All phases through 12 complete as of 2026-05-15. Phase 13 (notification detail view) also complete — see below.

---

## Phase 13 — Notification detail view (Wave 9, Issues 18–19, commit 1e92b20)

**Goal:** Any notification in any portal can be clicked to read its full content, both when unread and after being read.

**Root cause found:** Both the internal `top-nav.tsx` and the HR `notification-bell.tsx` had `onClick` gated by `!n.read`, making already-read notifications completely unclickable. Neither had any detail state — long messages were truncated at two lines with no expand affordance.

**Fix applied — internal portal** (`apps/internal/src/components/top-nav.tsx`):
- Added `selectedNotif: any | null` state alongside existing `bellOpen`.
- Replaced per-notification `onClick` with a single `openNotif(n)` function that sets `selectedNotif` and conditionally calls `markAsRead`.
- Bell dropdown now renders two views conditionally:
  - **List view** (default): each row has a `>` chevron; all rows always clickable.
  - **Detail view** (when `selectedNotif` set): full title, `whitespace-pre-wrap` message body, `en-IN` formatted timestamp; `← Back` button resets `selectedNotif`.
- Outside-click handler and bell-button click both reset `selectedNotif`.

**Fix applied — HR portal** (`apps/hr/src/components/notification-bell.tsx`):
- Full rewrite with identical `selectedNotif` pattern.
- Added `timeAgo()` helper (consistent with internal portal).
- Added `BellOff` and `CheckCheck` icon imports for empty state and mark-all-read UX.

---

## Key File Reference

| Concern | File |
|---|---|
| DB schema | `packages/db/prisma/schema.prisma` |
| Admin validators | `packages/shared/src/validators/` |
| Admin features routes | `apps/api/src/routes/admin-features.routes.ts` |
| Admin reports routes | `apps/api/src/routes/admin-reports.routes.ts` |
| Employee service | `apps/api/src/services/employee.service.ts` |
| Employee profile service | `apps/api/src/services/employee-profile.service.ts` |
| Attendance service | `apps/api/src/services/attendance.service.ts` |
| Route aggregator | `apps/api/src/routes/index.ts` |
| Internal auth middleware | `apps/api/src/middleware/auth.ts` |
| SWR hooks | `apps/internal/src/lib/hooks/` |
| Auth context | `apps/internal/src/lib/auth.ts` |
| API HTTP client | `apps/internal/src/lib/api.ts` |
| Tailwind config | `apps/internal/tailwind.config.ts` |
| Shared UI | `packages/ui/` |
| Client invite endpoint | `apps/api/src/routes/client.routes.ts` → `POST /v1/client/auth/invite-request` |
| Announcement service | `apps/api/src/services/announcement.service.ts` |
| Announcement routes | `apps/api/src/routes/admin-features.routes.ts` → `POST/GET /admin/announcements` |
| Announcement SWR hook | `apps/internal/src/lib/hooks/use-announcements.ts` |
| Announcements page | `apps/internal/src/app/announcements/page.tsx` |
