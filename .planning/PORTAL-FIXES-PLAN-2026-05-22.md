# Portal fixes plan — 2026-05-22

## Implementation status — 2026-05-22

**Implemented in this session (all TypeScript checks pass):**

| Issue | Status | Notes |
|---|---|---|
| Issue 1 (notification routing) | ✅ DONE | `notification-routing.ts` created; `dispatchNotification()` added; `notifyAdmins` deprecated; all callers in `hr-features.routes.ts`, `public-jobs.routes.ts`, `hr-auth.service.ts` migrated |
| Issue 2 (jobs portal contact) | ✅ DONE | Contact block added to listing page, job detail page, and post-submit success state |
| Issue 3 (leaderboard filter) | ✅ DONE | `employeeWhere` exported from `analytics.service.ts`; imported in `leaderboard.service.ts` |
| Issue 5 (team count) | ✅ DONE | `countTeams()` added to `team.service.ts`; `analytics.service.ts` now calls it |
| Issue 6 (employee edit 400) | ✅ DONE | Removed `.min(1)` from `updateEmployeeSchema.roleIds`; form no longer sends empty array |
| Issue 8 (task/content required fields) | ✅ DONE | `createTaskSchema` and `createContentPostSchema` now require `dueDate`/`accountId`/`scheduledAt`; forms show inline errors |
| Issue 11 (internship UI) | ✅ DONE | Header upgraded to `text-4xl`; modal restructured with sticky header + scrollable body + sticky footer pills |
| Issue 12 (scroll-to-top) | ✅ DONE | `useEffect` scroll reset added to `reports/[employeeId]/page.tsx` |
| Issue 13 (leave nav + page) | ✅ DONE | `CalendarOff` icon + `/leave` entry added to sidebar; `/leave/page.tsx` created with tabs + approve/reject |

**Deferred / not yet implemented:**
- Issue 1: Internal portal notification bell (Issues 1.4 + 1.5 — no bell component, no announcement history)
- Issue 4: Assign account modal portal (CSS `fixed` ancestor stacking context fix)
- Issue 5: DB-level diagnostic (psql queries needed on Linode to confirm root cause of 13 vs 8)
- Issue 7: Offer letter date coercion (validator + route wiring)
- Issue 9: Job application visibility diagnostic (SWR / DB check)
- Issues 10, 14: Schema-changing (require `db:push`) — deferred for next session
- Issues 1-bell, Announce history, Leave top-level (Issues 1.4–1.5, Issue 10 UI)

---

Five issues, scoped end-to-end so a Sonnet medium-thinking session can land them in one pass without further architectural decisions. Each issue has: **What's broken → Why → Fix → Files → Verification.**

Read this top-to-bottom before touching code. Do all five in one branch; one PR.

---

## Issue 1 — Notification routing is wrong (everyone gets everything)

### What's broken
Every notification (job applications, internship applications, employee registrations, leave requests, salary slips, etc.) is broadcast to **every Admin and Super Admin** via `notifyAdmins()`. Meanwhile, employees only get a narrow slice (report reminders, account assignments). The user reported "amey applied for a 3 months internship" landing in the bell — that's correct *for an admin* but the bell currently shows admin-relevant items mixed with employee-relevant items in the same stream with no separation, and there's no notification bell at all on the internal portal admin UI.

### Why
- [apps/api/src/services/notification.service.ts:16-44](apps/api/src/services/notification.service.ts#L16-L44) — `notifyAdmins()` fires for any role matching `Super Admin | Admin` case-insensitive. No type-to-role mapping.
- All triggers (`public-jobs.routes.ts`, `hr-features.routes.ts`, `hr-auth.service.ts`) use `notifyAdmins()` indiscriminately with `type: GENERAL`.
- HR portal has a working bell ([apps/hr/src/components/notification-bell.tsx](apps/hr/src/components/notification-bell.tsx)); internal portal does **not** — only the icon exists in the Mohammad screenshot, but no component is mounted. Need to confirm.
- Per user requirement: "Admins and Super Admins get all notifications, rest get notifications relevant to them (announcements, salary slips, leave approvals). People with multiple roles get all notifications relevant to them."

### Fix — implement a recipient-routing matrix

**1. Define routing in one place.** Create [apps/api/src/services/notification-routing.ts](apps/api/src/services/notification-routing.ts):

```ts
import { NotificationType } from "@prisma/client";

// Each type lists which audiences it should reach.
// "ADMINS" = users with Super Admin or Admin role.
// "RECIPIENT" = a specific user passed by the caller (e.g. the employee whose leave was approved).
// "ALL_EMPLOYEES" = used only for ANNOUNCEMENT — already handled separately by announcement.service.ts.
export const NOTIFICATION_AUDIENCE: Record<NotificationType, Array<"ADMINS" | "RECIPIENT" | "ALL_EMPLOYEES">> = {
  // Admin-only (operational)
  REPORT_SUBMITTED:     ["ADMINS"],
  REPORT_MISSED:        ["ADMINS"],

  // Employee-only (personal/HR outcomes)
  REPORT_REMINDER:      ["RECIPIENT"],
  GROWTH_MILESTONE:     ["RECIPIENT"],
  ACCOUNT_ASSIGNED:     ["RECIPIENT"],
  LEAVE_APPROVED:       ["RECIPIENT"],
  LEAVE_REJECTED:       ["RECIPIENT"],
  SALARY_SLIP:          ["RECIPIENT"],
  DOCUMENT_UPLOADED:    ["RECIPIENT"], // sent BACK to employee on admin upload
  PROFILE_PICTURE:      ["RECIPIENT"],
  PERFORMANCE_REVIEW:   ["RECIPIENT"],
  INCENTIVE_AWARDED:    ["RECIPIENT"],
  EXTRA_HOURS_APPROVED: ["RECIPIENT"],

  // Both — admin needs to act, recipient might want to know
  LEAVE_REQUEST:        ["ADMINS"],            // raised by employee, only admins need to see
  BUG_REPORT_UPDATE:    ["ADMINS", "RECIPIENT"],

  // Broadcasts
  ANNOUNCEMENT:         ["ALL_EMPLOYEES"],     // already handled in announcement.service.ts
  GENERAL:              ["ADMINS"],            // default for job apps, expense claims, complaints, etc.
};
```

**2. Add a single dispatch helper** in [apps/api/src/services/notification.service.ts](apps/api/src/services/notification.service.ts):

```ts
export async function dispatchNotification(opts: {
  type: NotificationType;
  title: string;
  message: string;
  recipientUserId?: string; // required when audience includes RECIPIENT
  metadata?: Record<string, any>;
}) {
  const audiences = NOTIFICATION_AUDIENCE[opts.type] ?? ["ADMINS"];
  const userIds = new Set<string>();

  if (audiences.includes("ADMINS")) {
    const admins = await prisma.user.findMany({
      where: {
        status: "ACTIVE",
        deletedAt: null,
        roles: { some: { role: { name: { in: ["Super Admin", "Admin"] } } } },
      },
      select: { id: true },
    });
    admins.forEach((a) => userIds.add(a.id));
  }

  if (audiences.includes("RECIPIENT") && opts.recipientUserId) {
    userIds.add(opts.recipientUserId);
  }

  // ALL_EMPLOYEES is handled by announcement.service.ts directly — skip here.

  if (userIds.size === 0) return;

  await prisma.notification.createMany({
    data: Array.from(userIds).map((userId) => ({
      userId,
      type: opts.type,
      title: opts.title,
      message: opts.message,
      metadata: opts.metadata ?? {},
    })),
  });
}
```

**3. Migrate every caller** from `notifyAdmins(...)` to `dispatchNotification({ type: <specific>, ... })`. Use the correct `NotificationType` for each trigger instead of `GENERAL`:

| Trigger | File | New type |
|---|---|---|
| Job application | [apps/api/src/routes/public-jobs.routes.ts:56-61](apps/api/src/routes/public-jobs.routes.ts#L56) | `GENERAL` (admin-only — keep as is, the audience is correct) |
| Internship application | [apps/api/src/routes/public-jobs.routes.ts:116](apps/api/src/routes/public-jobs.routes.ts#L116) | `GENERAL` |
| New employee registration | [apps/api/src/services/hr-auth.service.ts](apps/api/src/services/hr-auth.service.ts) | `GENERAL` |
| Leave request | hr-features.routes.ts (leave POST) | `LEAVE_REQUEST` |
| Leave approve/reject | hr-features.routes.ts | `LEAVE_APPROVED` / `LEAVE_REJECTED` with `recipientUserId: leaveReq.employeeId` |
| Salary slip generated | [apps/api/src/services/salary.service.ts](apps/api/src/services/salary.service.ts) and admin-features bulk slip route | `SALARY_SLIP` with `recipientUserId: employeeId` |
| Extra hours approved | hr-features.routes.ts | `EXTRA_HOURS_APPROVED` with `recipientUserId` |
| Expense claim submitted | hr-features.routes.ts | `GENERAL` (admin notification) |
| Document uploaded by employee | hr-features.routes.ts | `GENERAL` (admin notification — uses different audience than the `DOCUMENT_UPLOADED` enum which is employee-facing; OK to use `GENERAL` here) |
| Complaint submitted | hr-features.routes.ts | `GENERAL` |
| Joining date submitted | hr-features.routes.ts | `GENERAL` |
| Account assigned to employee | [apps/api/src/services/account.service.ts](apps/api/src/services/account.service.ts) (assign endpoint) | `ACCOUNT_ASSIGNED` with `recipientUserId: assignedToId` |

**Keep `notifyAdmins()` exported** as a thin wrapper that calls `dispatchNotification({ type: "GENERAL", ... })` so any caller we miss still works. Mark it `@deprecated` in JSDoc.

**4. Build the missing internal portal notification bell.** Copy [apps/hr/src/components/notification-bell.tsx](apps/hr/src/components/notification-bell.tsx) to [apps/internal/src/components/notification-bell.tsx](apps/internal/src/components/notification-bell.tsx). Change the endpoints from `/hr/notifications*` to `/admin/notifications*` (these already exist — see [apps/api/src/routes/admin-features.routes.ts](apps/api/src/routes/admin-features.routes.ts) for the admin-notifications routes). Mount it in the internal topbar where the bell icon currently shows. The HR styling can stay; internal uses ink/indigo so swap any HR-specific token colors.

**5. Send-announcement history page.** The endpoint `GET /admin/announcements` already exists ([admin-features.routes.ts:1350](apps/api/src/routes/admin-features.routes.ts#L1350)). Add a "History" tab/section to the existing announcements page in the internal portal (search `apps/internal/src/app/announcements/` — if no page exists, create [apps/internal/src/app/announcements/page.tsx](apps/internal/src/app/announcements/page.tsx)) that lists past sends with sender name, recipient count, timestamp, title preview. Per user requirement: this history must be visible to all (employees viewing announcements should see what was sent, when, by whom).

Add a parallel `GET /hr/announcements` endpoint (in [hr-features.routes.ts](apps/api/src/routes/hr-features.routes.ts)) that returns the same list — so HR portal users can view announcement history too. The HR endpoint requires only authentication, no admin role.

### Verification
1. `dispatchNotification({ type: "LEAVE_REQUEST", title: "x", message: "y" })` from a debug route — confirm only Admin/Super Admin users got a row.
2. `dispatchNotification({ type: "LEAVE_APPROVED", recipientUserId: <employeeId>, ... })` — confirm only that one employee got a row, no admins.
3. Submit an actual leave request in HR portal → check the leave-approver admin's bell shows the notification, but a non-admin employee's bell does NOT.
4. Approve that leave → check the *employee's* bell shows `LEAVE_APPROVED`, no other employee gets it.
5. Send an announcement → confirm all employees see it AND the "Announcements history" tab shows the send with the right sender name and recipient count.
6. Internal portal bell renders, polls every 30s, marks unread on click.

---

## Issue 2 — Customer support / contact for job applicants

### What's broken
Applicants submit via the public jobs portal but have no way to follow up. The portal shows no support email, contact form, or way to ask "what's the status of my application?" The user said: "whatever is simpler and quick."

### Fix — static contact info on the jobs portal (no backend, no DB changes)

1. **Add a "Questions about your application?" block** to the bottom of [apps/jobs/src/app/page.tsx](apps/jobs/src/app/page.tsx) (the job listings page) and [apps/jobs/src/app/jobs/[id]/page.tsx](apps/jobs/src/app/jobs/[id]/page.tsx) (the job detail page). One paragraph, `mailto:` link to `careers@digitalsukoon.com` (or whatever address HR confirms — fall back to `hr@digitalsukoon.com` which is already in `SMTP_USER`).
2. **Add the same block to the post-submit success state** on the job application form — when an applicant sees "Thank you, we'll review it shortly," show "Have a question? Email careers@digitalsukoon.com."
3. **Update the auto-confirmation email** in [apps/api/src/services/email.service.ts](apps/api/src/services/email.service.ts) — the `sendApplicationNotification` template currently says "we will review it shortly." Append: "If you have any questions, reply to this email or contact careers@digitalsukoon.com." Set the email `replyTo` header to the same address.

Total scope: 3 file edits, no DB, no API routes. The admin-reply UI from the original option is deferred — if applicants email back, HR replies from Gmail like any other thread.

### Verification
- Visit `https://localhost:3003` (jobs portal), confirm the contact block is visible on listing + detail + post-submit.
- Submit a test application, confirm the confirmation email contains the new line.

---

## Issue 3 — Leaderboard accuracy across HR + Internal

### What's broken
Both HR and Internal portals show the same leaderboard (both call `getLeaderboard()` in [apps/api/src/services/leaderboard.service.ts:4-73](apps/api/src/services/leaderboard.service.ts#L4-L73)). The service queries `DailyReport` directly with **no role filter**, so any Super Admin or Admin who submits a report shows up ranked alongside employees and can inflate or skew the rankings.

This is the same class of bug as the dashboard "Active Employees" miscount documented in CLAUDE.md — fixed there by introducing the `employeeWhere` constant in `analytics.service.ts`.

### Fix
1. **Reuse the `employeeWhere` filter.** Open [apps/api/src/services/leaderboard.service.ts](apps/api/src/services/leaderboard.service.ts). Where it queries `DailyReport` (around lines 12-19), join through `employee` and filter:
   ```ts
   const reports = await prisma.dailyReport.findMany({
     where: {
       employee: {
         status: "ACTIVE",
         deletedAt: null,
         roles: { some: { role: { name: { notIn: ["Super Admin", "Admin"] } } } },
       },
       // ...existing date filter
     },
     include: { employee: { select: { id: true, name: true, profilePictureUrl: true } } },
   });
   ```
2. **Or, better:** Export `employeeWhere` from `analytics.service.ts` (currently it's a local const) and import it in leaderboard.service.ts so the rule lives in exactly one place. If two services need it, they both reference the same constant — drift-proof.
3. **Verify HR + Internal leaderboards now show identical employee-only rankings.** The two portals already call the same service, so fixing the service fixes both.

### Verification
- Log in as `tabish@dashmani.com` (Super Admin) and submit a daily report.
- Check [/leaderboard](apps/hr/src/app/leaderboard) (HR) and [/reports/leaderboard](apps/internal/src/app/reports/leaderboard) (internal). Tabish should NOT appear in either.
- A regular employee with 30 reports should still appear.

---

## Issue 4 — "Assign Account" modal positioning bug

### What's broken
On `/accounts` in the internal portal, clicking "+ Assign" on a row opens a modal that appears far down the page — the user has to scroll to find it (see attached screenshot).

### Root cause
[apps/internal/src/app/accounts/page.tsx](apps/internal/src/app/accounts/page.tsx) at line 266 (`AssignModal`) wraps the modal card in `<div className="v3-card shadow-pop w-full max-w-lg overflow-hidden pop-in">`. The `overflow-hidden` on the inner card combined with the employee combobox dropdown's `absolute z-10 mt-1` positioning (line ~296) interacts oddly — but the real reported symptom is the modal *itself* being far down the page, not the dropdown.

Re-investigate during implementation: the more likely cause is a missing `position: fixed` *parent stacking context*. The outer wrapper at line 266 does have `fixed inset-0 z-50 flex items-center justify-center` — so on paper it should center. But if any parent of `<AssignModal />` in `accounts/page.tsx` uses `transform`, `filter`, `perspective`, `will-change`, or `contain: paint`, the `fixed` element is positioned relative to that ancestor instead of the viewport. CSS spec.

### Fix
1. **Portal the modal to `document.body`.** Wrap `AssignModal` (and `DeleteModal`, and any other modal in this file) in a React portal via `createPortal(<...>, document.body)`. This guarantees the modal escapes any transformed ancestor.
2. **Check `QuickAssignModal`** on the dashboard ([apps/internal/src/app/dashboard/page.tsx](apps/internal/src/app/dashboard/page.tsx)) — same pattern, same portal fix needed.
3. **Repeat for any other in-flow modals** in the internal portal. Search: `rg -n 'fixed inset-0' apps/internal/src/app/ apps/internal/src/components/` and check each for portal usage.
4. **Standardize.** If there's an existing portal/modal helper in `@dashmani/ui` or `apps/internal/src/components/portal-shared.tsx`, use it; if not, create [apps/internal/src/components/modal-portal.tsx](apps/internal/src/components/modal-portal.tsx) — a thin `createPortal` wrapper that returns `null` during SSR.
5. **While here, fix the combobox dropdown** at line 296 of `accounts/page.tsx`: the search dropdown should NOT push the modal layout. Set the parent `<div>` containing the input + dropdown to `relative` (it already is) and give the dropdown `absolute top-full left-0 w-full mt-1` instead of just `mt-1`. Confirm the modal card no longer has `overflow-hidden` (remove it — the dropdown needs to overflow the card visually) and add `overflow-y-auto` to the modal body container if needed.

### Verification
- Open `/accounts`, click "+ Assign" on any row → modal appears centered in the viewport on first frame, no scrolling needed.
- Type in the employee search → dropdown appears below input, doesn't push modal layout.
- Test on the dashboard's `QuickAssignModal` too.
- Test on mobile viewport (375px) — modal should still center.

---

## Issue 5 — Team count discrepancy (dashboard 13 vs teams page 8)

### What's broken
Dashboard shows "13" for teams. The `/teams` page shows "8". Both query `OrgUnit` with `parentId: null` (top-level only), and OrgUnit has no `deletedAt` field, so on paper they should match.

### Investigate first, then unify (per user direction)

**Step A — Run the diagnostic queries in Prisma Studio or via `psql`:**

```sql
-- Total OrgUnit rows
SELECT COUNT(*) FROM "OrgUnit";

-- Top-level only
SELECT COUNT(*) FROM "OrgUnit" WHERE "parentId" IS NULL;

-- By parent presence
SELECT
  CASE WHEN "parentId" IS NULL THEN 'top-level' ELSE 'child' END AS level,
  COUNT(*)
FROM "OrgUnit"
GROUP BY 1;

-- List them so we can eyeball
SELECT id, name, "parentId", "createdAt" FROM "OrgUnit" ORDER BY "parentId" NULLS FIRST, name;
```

Run on prod (`ssh linode && sudo -u postgres psql -d dashmani_prod`).

**Step B — Based on what the diagnostic shows, one of these is true:**

| Diagnostic result | Cause | Fix |
|---|---|---|
| `COUNT(parentId IS NULL)` = 13, total = 13 | Dashboard right, teams page wrong. Teams page is filtering something (status, deletedAt, has-members) that dashboard isn't. | Make teams page match dashboard: drop the extra filter, or document why it exists. |
| `COUNT(parentId IS NULL)` = 8, total = 13 | Teams page right, dashboard wrong. Dashboard's query must be hitting something other than `parentId: null` — perhaps double-counting or counting something else. | Re-read [apps/api/src/services/analytics.service.ts:67](apps/api/src/services/analytics.service.ts#L67) — confirm the query. Match it to `team.service.ts:listOrgUnits` exactly. |
| `COUNT(parentId IS NULL)` = 8, total > 13 | Both queries are "top-level only" but one is including child units. | Look for a different code path — maybe the dashboard query counts via a different relation (Team→User→teamId distinct count?). |
| Numbers match in DB but UI differs | Stale SWR cache or refresh interval. | Refresh page; if still off, check the SWR hook's `dedupingInterval`. |

**Step C — Unify.** Once the source of truth is identified, export a shared `getTeamCount()` helper in `team.service.ts` and call it from both the dashboard analytics service AND the teams page endpoint. Single query, single result, no drift.

```ts
// apps/api/src/services/team.service.ts
export async function countTeams() {
  return prisma.orgUnit.count({ where: { parentId: null } });
}
```

Replace [analytics.service.ts:67](apps/api/src/services/analytics.service.ts#L67) `prisma.orgUnit.count({ where: { parentId: null } })` with `countTeams()`, and have the teams page use the same helper for its header count.

**Step D — Sanity-check labels.** "Teams" on the dashboard may semantically mean something different from "Org Units" on the teams page (e.g., teams might mean "departments with at least one active member"). If that's the intent, rename the dashboard stat to match what it actually counts, OR change the filter to include the member-count predicate everywhere. Don't ship two queries that differ in scope under the same label.

### Verification
- Run the SQL queries above, document the actual counts in a comment in the PR description.
- Dashboard "Teams" stat and `/teams` page header MUST match after the unify step.
- Soft-delete a team via the teams page (or hard-delete since OrgUnit has no `deletedAt`) — both counts decrement together on next refresh.

---

## Cross-cutting checks before merge

1. **No DB migration needed for any of these.** No schema changes. (If during Issue 5 we add `deletedAt` to OrgUnit, that becomes additive and requires `db:push` on Linode — flag this in the PR description.)
2. **`employeeWhere` import path consistency** — Issue 3's fix should import from `analytics.service.ts` (per CLAUDE.md convention). If multiple services need it, promote the constant to a shared utility in `packages/shared/src/utils/` and re-export from `analytics.service.ts`.
3. **Build all four apps**: `npm run build` from repo root, not per-app. The leaderboard service is imported by both HR and Internal route handlers — TS must check both.
4. **Type checks**: `npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/internal/tsconfig.json && npx tsc --noEmit -p apps/hr/tsconfig.json && npx tsc --noEmit -p apps/jobs/tsconfig.json`.
5. **Smoke the bell on both portals** end-to-end — trigger a real leave request as one employee and confirm:
   - Admins see it in the internal portal bell (and HR portal bell if they have HR access).
   - Other employees do NOT see it.
   - The requesting employee does NOT see their own request as a notification (they raised it).
6. **Don't regress announcements.** [announcement.service.ts](apps/api/src/services/announcement.service.ts) currently creates `Notification` rows directly with `type: ANNOUNCEMENT` for every active employee — keep that logic untouched. The new `dispatchNotification()` should NOT be used for announcements.

---

## Issue 6 — Employee edit fails with "Invalid request data"

### What's broken
On the internal portal, editing an employee's name (or any field) returns 400 "Invalid request data". Reported by user as: "Still can't update employee name OR any information."

### Why
- Form: [apps/internal/src/components/employee-form.tsx:40-48](apps/internal/src/components/employee-form.tsx#L40-L48) always sends `roleIds: [...]` in the PATCH payload — including when the array is empty (employee has no roles or roles weren't changed).
- Validator: [packages/shared/src/validators/employee.ts:21](packages/shared/src/validators/employee.ts#L21) declares `roleIds: z.array(z.string().uuid()).min(1).optional()`.
- `.optional()` allows the field to be omitted entirely, but if present it must have ≥1 element. The form sends `[]` → Zod rejects → the `validate` middleware returns the canonical 400 "Invalid request data" envelope.

### Fix
Two options — do **both** so this can't recur:

1. **Validator (server side):** change [packages/shared/src/validators/employee.ts:21](packages/shared/src/validators/employee.ts#L21) to drop the `.min(1)` constraint:
   ```ts
   roleIds: z.array(z.string().uuid()).optional()
   ```
   Empty array is fine — service code already handles "no roles" (employee just has none).
2. **Form (client side):** in `employee-form.tsx`, exclude `roleIds` from the payload when no role changes were made, OR send `undefined` when the array is empty:
   ```ts
   const payload = {
     name: form.name,
     // ...
     ...(form.roleIds && form.roleIds.length > 0 ? { roleIds: form.roleIds } : {}),
   };
   ```

### Verification
- Edit an employee's name only, leave roles untouched → save → success, name updates in the list.
- Edit an employee and explicitly remove all roles → save → no 400 (server accepts empty array).
- Edit an employee and change roles to a non-empty set → save → roles update.

---

## Issue 7 — Offer letter generation fails with "error occurred"

### What's broken
On the internal portal offer-letter page, clicking generate returns a generic "error occurred" with nothing useful in the UI.

### Why
[apps/internal/src/app/offer-letters/page.tsx:43-72](apps/internal/src/app/offer-letters/page.tsx#L43-L72) submits `offerDate` and `joiningDate` as ISO date strings from `<input type="date">`. The API route at [apps/api/src/routes/admin-features.routes.ts:257-259](apps/api/src/routes/admin-features.routes.ts#L257-L259) spreads `req.body` directly into the service call. The service ([apps/api/src/services/offer-letter.service.ts:4-14](apps/api/src/services/offer-letter.service.ts#L4-L14)) types these as `Date`, and downstream Prisma writes them to `DateTime` columns. Prisma rejects strings → unhandled error → caught by the global error handler → vague "An unexpected error occurred" sent back to the UI.

There's no Zod validator on this route at all, which is why the bug bypassed the validator catch.

### Fix
1. **Add a Zod validator** for the offer-letter route with `z.coerce.date()` for date fields:
   ```ts
   // packages/shared/src/validators/offer-letter.ts (new file)
   export const generateOfferLetterSchema = z.object({
     employeeId: z.string().uuid(),
     position: safeString.pipe(z.string().min(2).max(200)),
     salary: z.number().positive(),
     offerDate: z.coerce.date(),
     joiningDate: z.coerce.date(),
     // ...other fields the service expects
   });
   ```
2. **Attach it to the route** at [admin-features.routes.ts:257](apps/api/src/routes/admin-features.routes.ts#L257) via the existing `validate(generateOfferLetterSchema)` middleware pattern (search the file — other routes use it).
3. **Verify the same pattern isn't bleeding** into appointment-letter or employment-contract generation routes nearby. If they also accept dates without coercion, fix those too (likely 2 more routes in the same file).
4. **Improve the user-facing error** — when generation fails, the page should show the actual error message from the API envelope (`data.error.message`), not a hardcoded "error occurred". Read the existing page to see how errors are currently swallowed.

### Verification
- Pick an employee, fill out the form, click Generate → PDF generates and downloads/displays.
- Submit with an invalid date → user sees a clear validation message, not "error occurred".

---

## Issue 8 — Tasks and Content posts can be created with no date / no account

### What's broken
The "New Task" form lets users submit with no `dueDate` and no `accountId`. Same for "New Content" / ContentPost. Per user: "Task get posted even without selecting date and assigning account / Content get posted even without selecting date and assigning account."

### Why
Both surfaces have validators that mark the relevant fields `.optional()`:

- **Task:** [packages/shared/src/validators/task.ts:8-10](packages/shared/src/validators/task.ts#L8-L10) — `dueDate` and `accountId` both `.optional()`. Form [apps/internal/src/components/task-form.tsx:48-49](apps/internal/src/components/task-form.tsx#L48-L49) sends `undefined` for empty values. DB has both columns nullable.
- **Content:** [packages/shared/src/validators/content.ts:9-10](packages/shared/src/validators/content.ts#L9-L10) — `accountId` and `scheduledAt` `.optional()`. Form [apps/internal/src/components/content-form.tsx:46-47](apps/internal/src/components/content-form.tsx#L46-L47) sends `undefined`. DB columns nullable.

DB nullability is fine to keep — there are legitimate task/content rows without these (e.g. legacy data, or "Backlog" tasks). The fix is at the **validator + form** layer for *new* records.

### Fix
**Make them required at create-time only, keep optional at update-time.**

1. **Split the schemas.** In `validators/task.ts`, define `createTaskSchema` (required `dueDate`, required `accountId`) and `updateTaskSchema` (both `.optional()` for partial updates). The current single schema is currently used for both — split it. Same pattern for content.

   ```ts
   // task.ts
   export const createTaskSchema = z.object({
     title: safeString.pipe(z.string().min(2).max(200)),
     dueDate: z.coerce.date(),           // REQUIRED
     accountId: z.string().uuid(),       // REQUIRED
     // ...other fields
   });
   export const updateTaskSchema = createTaskSchema.partial();
   ```
2. **Wire them up in the routes.** POST → `createTaskSchema`. PATCH/PUT → `updateTaskSchema`. Same for the content routes.
3. **Client-side guard.** In each form, disable the Submit button until `dueDate` and `accountId` are set; show inline "Required" helper text under empty fields. This is the user-visible UX fix — the validator change just makes sure no one bypasses it via API.
4. **Don't add a DB migration.** Existing nullable columns stay nullable; old rows survive.

### Verification
- Try to create a Task with no date → submit blocked client-side; if you bypass with curl → 400 with "dueDate is required".
- Try to create Content with no scheduled date → same.
- Editing an existing Task/Content without setting these → still works (update schema allows partial).

---

## Issue 9 — Job applications not reflecting in admin portal

### What's broken
Public users submit job applications via the jobs portal; admins don't see them in the internal portal applications list.

### Why
The public POST writes to the same `JobApplication` table the admin GET reads from ([public-jobs.routes.ts:35-82](apps/api/src/routes/public-jobs.routes.ts#L35-L82) → status defaults to `RECEIVED` via Prisma default; admin endpoint at [admin-features.routes.ts:638](apps/api/src/routes/admin-features.routes.ts#L638) calls `getApplications()` in [job-listing.service.ts:107-115](apps/api/src/services/job-listing.service.ts#L107-L115) with **no status filter**). So there's no schema-level reason the rows shouldn't show.

Three remaining suspects — diagnose in order:

1. **Stale SWR cache** on the admin applications page. The page may be SWR-cached and not refetching on focus.
2. **Frontend filter on the admin page** filtering out `RECEIVED` status (e.g. default tab is "Reviewing").
3. **Submission silently failing** — public POST returns 200 but the `prisma.jobApplication.create()` is being rolled back inside a `try/catch` that swallows the error.

### Fix (diagnostic-first)
**Step A:** Submit a test application from the public portal. Then run:
```bash
ssh linode "sudo -u postgres psql -d dashmani_prod -c \"SELECT id, name, status, \\\"createdAt\\\" FROM \\\"JobApplication\\\" ORDER BY \\\"createdAt\\\" DESC LIMIT 5;\""
```
Locally: `npm run db:studio` and inspect the `JobApplication` table.

| What you see | Cause | Fix |
|---|---|---|
| Row IS in the DB | Frontend issue (cache or filter) | Below |
| Row is NOT in the DB | Backend silent failure | Inspect [public-jobs.routes.ts:35-82](apps/api/src/routes/public-jobs.routes.ts) for swallowed errors; ensure `await` is on the create; add proper error rethrow |

**Step B (if row is in DB):**
1. Open the admin applications page (find it — likely `apps/internal/src/app/jobs/applications/page.tsx` or under `apps/internal/src/app/applications/`).
2. Check the SWR hook: add `revalidateOnFocus: true` and a manual refresh button. Drop any `dedupingInterval` that's too long.
3. Check the default tab/filter: if the page defaults to `status: "REVIEWING"`, change the default to `status: "ALL"` or `"RECEIVED"` so new applications are visible immediately.
4. The notification bell (after Issue 1's fix) should also surface new applications to admins as a GENERAL notification — verify that channel works in parallel as a secondary confirmation.

### Verification
- Submit a test job application from the jobs portal.
- Within 30s, see it appear in the admin portal applications list (without manual refresh, or with one click of a refresh button).
- A notification fires in the admin's bell.

---

## Issue 10 — Send Announcement should target specific teams, not everyone

### What's broken
Today, `POST /admin/announcements` broadcasts to every active employee. User wants the option to target a specific team / OrgUnit.

### Why
- API: [admin-features.routes.ts:1328-1346](apps/api/src/routes/admin-features.routes.ts#L1328) accepts only `title` and `message`.
- Service: [announcement.service.ts:4-51](apps/api/src/services/announcement.service.ts#L4-L51) — `broadcastAnnouncement()` queries every `status: ACTIVE` user with no filter.
- Schema: [packages/db/prisma/schema.prisma:747-759](packages/db/prisma/schema.prisma#L747) — `Announcement` model has no `orgUnitId` field.

### Fix
**Additive — does not break existing behavior.**

1. **Schema (additive, requires `db:push`):** add to `Announcement` model:
   ```prisma
   orgUnitId String?   // null = broadcast to all employees
   orgUnit   OrgUnit?  @relation(fields: [orgUnitId], references: [id], onDelete: SetNull)
   ```
   And inverse `announcements Announcement[]` on `OrgUnit`. ⚠️ **`db:push` on Linode after deploy.**
2. **Validator:** add `orgUnitId: z.string().uuid().optional()` to the announcement payload Zod schema.
3. **Service:** update `broadcastAnnouncement(opts)` to accept an optional `orgUnitId` and filter recipients:
   ```ts
   const recipients = await prisma.user.findMany({
     where: {
       status: "ACTIVE",
       deletedAt: null,
       ...(opts.orgUnitId ? { orgUnitId: opts.orgUnitId } : {}),
     },
     select: { id: true },
   });
   ```
   Confirm the `User` model has an `orgUnitId` foreign key (it should, based on prior team-membership work). If users are linked to OrgUnits via a separate join table, query through that relation instead.
4. **UI:** in the announcement-send form ([apps/internal/src/app/announcements/page.tsx](apps/internal/src/app/announcements/page.tsx) — being built or extended per Issue 1), add a "Send to" selector with options:
   - **Everyone** (default) — sends with no `orgUnitId`
   - **A specific team** — dropdown of OrgUnits from `GET /admin/teams` (or `/teams`)
5. **History display** (also from Issue 1): show the recipient scope on each row — "All employees" or "Team: Editorial".

### Verification
- Send an announcement to "Everyone" → all active employees get a notification (matches current behavior).
- Send an announcement to "Editorial" team → only Editorial members get a notification; users outside that team do NOT.
- The history page shows the recipient scope label on each row.

---

## Issue 11 — Job/internship submissions: small UX wins

### What's broken (from the docx)
- **"UI Discrepancy issue in internship header":** [apps/internal/src/app/internships/page.tsx:47](apps/internal/src/app/internships/page.tsx#L47) uses `font-serif text-3xl font-light`, while [apps/internal/src/app/jobs/page.tsx:156](apps/internal/src/app/jobs/page.tsx#L156) uses `font-serif text-4xl font-light`. Badge placement also differs.
- **Internship application detail modal — status pills require scroll** (see attached docx image): the modal at [apps/internal/src/app/internships/page.tsx:65-97](apps/internal/src/app/internships/page.tsx#L65-L97) is `max-h-[80vh] overflow-y-auto`; status action pills (`RECEIVED / REVIEWING / SHORTLISTED / OFFERED`) sit at line 89-95 *after* the cover letter and notes, with no sticky footer. Users have to scroll to find them.

### Fix
1. **Unify header sizes.** Change internships header to `text-4xl` to match jobs page. Match the badge styling: copy the badge container from `jobs/page.tsx:157-162` and reuse it in `internships/page.tsx`.
2. **Sticky action pills.** Restructure the internship application modal:
   ```tsx
   <div className="modal-card max-h-[80vh] flex flex-col">
     <div className="px-6 pt-6 pb-2 border-b border-ink/10">{/* header */}</div>
     <div className="flex-1 overflow-y-auto px-6 py-4">{/* scrollable body */}</div>
     <div className="border-t border-ink/10 px-6 py-3 bg-paper">
       {/* status pills always visible */}
     </div>
   </div>
   ```
   The body becomes the only scrollable region; pills are pinned to the bottom of the modal regardless of scroll position.
3. **Apply the same pattern to the jobs application modal** if it has the same shape — likely [apps/internal/src/app/jobs/page.tsx](apps/internal/src/app/jobs/page.tsx) — for consistency.

### Verification
- Internship header visually matches the jobs header (size, font, badge).
- Open any internship application → status pills visible at the bottom of the modal without scrolling, even with long cover letters.

---

## Issue 12 — "View employee report" scrolls to wrong position

### What's broken
Clicking "View Details" on `/reports` summary takes you to `/reports/[employeeId]`, but the page mounts with the previous page's scroll position preserved. User has to scroll up to see the employee header.

### Why
Next.js App Router preserves scroll on client-side navigation by default. [apps/internal/src/app/reports/[employeeId]/page.tsx](apps/internal/src/app/reports/[employeeId]/page.tsx) has no explicit scroll reset.

### Fix
Add a scroll-to-top effect on mount:
```ts
useEffect(() => {
  window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
}, [params.employeeId]);
```

Apply the same to any other detail page that exhibits the issue — at minimum `/reports/[employeeId]`. Optionally check `/employees/[id]`, `/projects/[id]`, `/clients/[id]` for the same pattern.

### Verification
- Scroll halfway down `/reports`, click "View Details" → land at the top of `/reports/[employeeId]`.
- Use browser back button → scroll position on `/reports` should be restored (Next.js handles this).

---

## Issue 13 — Leave navigation: surface in sidebar

### What's broken
"Leave" / leave approvals is buried — users go through "More" or "Approvals" to find it. User wants it as a top-level sidebar item with its own icon.

### Why
[apps/internal/src/components/sidebar.tsx:15-47](apps/internal/src/components/sidebar.tsx#L15-L47) — the primary nav has Dashboard, Employees, Teams, Tasks, Content, Accounts, Workload, Clients, Projects, Attendance, Approvals, Analytics, Reports, Expenses, Devices, Complaints, Bug Reports, AI Assistant, Announcements. **No standalone "Leave" entry** — leave-related approvals live inside `/approvals` which mixes leave with other approval types.

### Fix
1. **Add a new top-level nav entry "Leave"** in `sidebar.tsx` primary section. Place it near `Attendance` and `Approvals` (HR cluster). Use Lucide `CalendarOff` or `CalendarMinus2` icon (or any clear leave-y icon).
2. **Point it to a new route** `apps/internal/src/app/leave/page.tsx` that:
   - Lists all leave requests, filtered by status tabs: Pending / Approved / Rejected / All.
   - Action buttons on each pending row: Approve / Reject (calls existing PATCH endpoint).
   - Shows the employee, dates, type (CASUAL/SICK/EARNED), reason, and attached medical document if SICK (see Issue 14).
3. **API:** if a `GET /admin/leave` (list all leaves with filter) doesn't exist yet, add it to [admin-features.routes.ts](apps/api/src/routes/admin-features.routes.ts) — most likely it already does, since `/approvals` shows leave items today; reuse the same service function.
4. **Section grouping:** if the sidebar uses sections (e.g. "Operations", "HR", "Analytics"), put Leave under the HR section alongside Employees / Attendance / Salary Slips.

### Verification
- Open internal portal, sidebar shows "Leave" as a top-level item with an icon.
- Click → lands on `/leave` with tabs and the pending count visible.
- Approve a leave → status updates, employee gets a `LEAVE_APPROVED` notification (already wired by Issue 1).

---

## Issue 14 — Sick leave should allow document upload (medical certificate)

### What's broken
[apps/hr/src/app/leave/page.tsx:26-123](apps/hr/src/app/leave/page.tsx#L26-L123) — the leave request form has only Type, From, To, Reason. For `SICK` leave there's no way to attach a medical certificate.

### Why
[packages/db/prisma/schema.prisma:175-192](packages/db/prisma/schema.prisma#L175-L192) — `LeaveRequest` has no `attachmentUrl` field. The codebase already has a working file-upload pattern for `EmployeeDocument` (schema lines 804-824) using `fileName`, `filePath`, `fileSize`, `mimeType` — and the client-portal file upload from 2026-05-19 ([client/files](apps/client/src/app/files)) demonstrates how to wire the uploader on the API side via `POST /v1/client/files` and the `uploadFile()` helper in `api.ts`.

### Fix
**Reuse the existing upload pattern — additive, requires `db:push`.**

1. **Schema (additive):** add to `LeaveRequest`:
   ```prisma
   attachmentUrl     String?   // path to uploaded medical document
   attachmentName    String?   // original filename for display
   attachmentMime    String?
   attachmentSize    Int?
   ```
   ⚠️ **`db:push` on Linode after deploy.**
2. **API: new endpoint** `POST /hr/leave/upload-attachment` in [hr-features.routes.ts](apps/api/src/routes/hr-features.routes.ts) using the existing multer/upload middleware pattern (search for `multer` in the codebase to find the helper — used in profile-picture upload). Returns `{ url, fileName, mimeType, size }`.
3. **Create-leave service:** extend `createLeaveRequest()` in [apps/api/src/services/leave.service.ts](apps/api/src/services/leave.service.ts) to accept the four new optional fields and pass them to Prisma.
4. **Validator:** in `packages/shared/src/validators/leave.ts` add `attachmentUrl`, `attachmentName`, `attachmentMime`, `attachmentSize` as optional. Add a refinement: **if `type === "SICK"` AND leave duration >= 3 days → `attachmentUrl` required.** Short sick leaves (1-2 days) don't require a certificate; multi-day ones do. (Adjust the threshold if the org has a different policy — confirm before shipping.)
5. **HR form:** in [apps/hr/src/app/leave/page.tsx](apps/hr/src/app/leave/page.tsx) add a file input that appears only when `type === "SICK"`. Upload happens before form submit (call the new upload endpoint, store the returned URL in form state, then submit `createLeave` with `attachmentUrl`).
6. **Display in admin leave page (Issue 13):** show "📎 Medical certificate" link next to SICK leaves — opens the uploaded file in a new tab. Use the same access-control pattern as other uploads (requires admin auth).

### Verification
- HR portal: select Leave Type = Sick, form reveals a file upload input.
- Upload a PDF → submit → leave appears in admin portal `/leave` with a "View attachment" link.
- Try to submit a 3+ day sick leave with no attachment → blocked with "Medical certificate required."
- Casual / Earned leave → no file upload shown.

---

## File-by-file checklist (for the implementer)

| # | File | Action |
|---|---|---|
| 1 | `apps/api/src/services/notification-routing.ts` | **CREATE** — audience matrix |
| 2 | `apps/api/src/services/notification.service.ts` | **ADD** `dispatchNotification()`; mark `notifyAdmins` deprecated |
| 3 | `apps/api/src/routes/public-jobs.routes.ts` | Replace `notifyAdmins` calls (2x) with `dispatchNotification` |
| 4 | `apps/api/src/services/hr-auth.service.ts` | Replace `notifyAdmins` (2x) |
| 5 | `apps/api/src/routes/hr-features.routes.ts` | Replace all `notifyAdmins` calls with typed `dispatchNotification` (leave / expense / docs / hours / complaint / joining) |
| 6 | `apps/api/src/services/salary.service.ts` (or wherever slips are generated) | Add `dispatchNotification({ type: SALARY_SLIP, recipientUserId })` |
| 7 | `apps/api/src/services/account.service.ts` | Add `dispatchNotification({ type: ACCOUNT_ASSIGNED, recipientUserId })` on assign |
| 8 | `apps/internal/src/components/notification-bell.tsx` | **CREATE** — copy from HR, retarget to `/admin/notifications*` |
| 9 | Internal topbar (find it — likely `apps/internal/src/components/topbar.tsx` or similar) | Mount the new bell |
| 10 | `apps/internal/src/app/announcements/page.tsx` | **CREATE or EXTEND** — add history tab using `GET /admin/announcements` |
| 11 | `apps/hr/src/app/announcements/page.tsx` (if exists) or HR view | Add history tab using new `GET /hr/announcements` |
| 12 | `apps/api/src/routes/hr-features.routes.ts` | **ADD** `GET /hr/announcements` |
| 13 | `apps/jobs/src/app/page.tsx` | Add contact block |
| 14 | `apps/jobs/src/app/jobs/[id]/page.tsx` | Add contact block |
| 15 | `apps/jobs/src/app/jobs/[id]/apply/...` (success state) | Add contact line |
| 16 | `apps/api/src/services/email.service.ts` | Update `sendApplicationNotification` template + `replyTo` |
| 17 | `apps/api/src/services/leaderboard.service.ts` | Add `employeeWhere` filter to the report query |
| 18 | `apps/api/src/services/analytics.service.ts` | **EXPORT** `employeeWhere` so leaderboard can import it |
| 19 | `apps/internal/src/app/accounts/page.tsx` | Portal modals; fix dropdown overflow |
| 20 | `apps/internal/src/app/dashboard/page.tsx` | Portal `QuickAssignModal` |
| 21 | `apps/internal/src/components/modal-portal.tsx` | **CREATE** if no existing helper |
| 22 | `apps/api/src/services/team.service.ts` | Add `countTeams()` helper |
| 23 | `apps/api/src/services/analytics.service.ts` | Replace inline orgUnit count with `countTeams()` |
| 24 | (Verification only) Prisma Studio / psql | Run diagnostic SQL for Issue 5 |
| 25 | `packages/shared/src/validators/employee.ts` | Drop `.min(1)` on `roleIds` (Issue 6) |
| 26 | `apps/internal/src/components/employee-form.tsx` | Don't send empty `roleIds` array (Issue 6) |
| 27 | `packages/shared/src/validators/offer-letter.ts` | **CREATE** — Zod schema with `z.coerce.date()` (Issue 7) |
| 28 | `apps/api/src/routes/admin-features.routes.ts` | Attach validator to offer-letter route; check appointment/employment-contract routes for same date-coercion bug (Issue 7) |
| 29 | `apps/internal/src/app/offer-letters/page.tsx` | Surface real error message instead of "error occurred" (Issue 7) |
| 30 | `packages/shared/src/validators/task.ts` | Split into `createTaskSchema` (required dueDate+accountId) and `updateTaskSchema` (Issue 8) |
| 31 | `packages/shared/src/validators/content.ts` | Split into create/update schemas (Issue 8) |
| 32 | `apps/api/src/routes/` (task + content routes) | Wire create vs update schemas per method (Issue 8) |
| 33 | `apps/internal/src/components/task-form.tsx` | Disable submit until dueDate + accountId set; inline "Required" hints (Issue 8) |
| 34 | `apps/internal/src/components/content-form.tsx` | Same (Issue 8) |
| 35 | (Diagnostic only) DB / psql | Confirm job applications land in JobApplication (Issue 9) |
| 36 | `apps/internal/src/app/...applications/...` page | `revalidateOnFocus: true`, default tab = All / Received, refresh button (Issue 9) |
| 37 | `packages/db/prisma/schema.prisma` | **ADDITIVE** — `Announcement.orgUnitId` + relation; inverse on `OrgUnit` (Issue 10) ⚠️ db:push |
| 38 | `apps/api/src/services/announcement.service.ts` | Accept optional `orgUnitId`; filter recipients (Issue 10) |
| 39 | `apps/api/src/routes/admin-features.routes.ts` | Validator accepts `orgUnitId`; pass through (Issue 10) |
| 40 | `apps/internal/src/app/announcements/page.tsx` | "Send to" selector (Everyone / specific team); history shows scope (Issue 10) |
| 41 | `apps/internal/src/app/internships/page.tsx` | Header `text-4xl`; sticky-footer modal with status pills (Issue 11) |
| 42 | `apps/internal/src/app/jobs/page.tsx` | Apply same sticky-footer pattern if applications modal lives here (Issue 11) |
| 43 | `apps/internal/src/app/reports/[employeeId]/page.tsx` | Scroll-to-top on mount (Issue 12) |
| 44 | `apps/internal/src/components/sidebar.tsx` | Add top-level "Leave" nav entry with icon (Issue 13) |
| 45 | `apps/internal/src/app/leave/page.tsx` | **CREATE** — leave list/tabs/approve-reject (Issue 13) |
| 46 | `apps/api/src/routes/admin-features.routes.ts` | Confirm or add `GET /admin/leave` for the new page (Issue 13) |
| 47 | `packages/db/prisma/schema.prisma` | **ADDITIVE** — `LeaveRequest.attachmentUrl`/`Name`/`Mime`/`Size` (Issue 14) ⚠️ db:push |
| 48 | `apps/api/src/routes/hr-features.routes.ts` | **ADD** `POST /hr/leave/upload-attachment` using existing upload middleware (Issue 14) |
| 49 | `apps/api/src/services/leave.service.ts` | Accept attachment fields on create (Issue 14) |
| 50 | `packages/shared/src/validators/leave.ts` | Add attachment fields; refinement requiring attachment for SICK ≥ 3 days (Issue 14) |
| 51 | `apps/hr/src/app/leave/page.tsx` | Conditional file uploader when type=SICK (Issue 14) |
| 52 | `apps/internal/src/app/leave/page.tsx` | "View attachment" link beside SICK leaves (Issue 14) |

**Don't forget:** `npm run build` from repo root before push. Internal portal bell + announcements page touch new components — easy to miss a typecheck error in only the per-app build.

**Two `db:push` triggers in this PR:** Issue 10 (`Announcement.orgUnitId`) and Issue 14 (`LeaveRequest.attachment*`). Both are purely additive (new columns, never DROP). Run on Linode after the deploy completes — see CLAUDE.md "Schema-changing flow" section. Diff the table before pushing:
```bash
ssh linode && cd /opt/dashmani-platform
sudo -u postgres psql -d dashmani_prod -c "\\d \"Announcement\""
sudo -u postgres psql -d dashmani_prod -c "\\d \"LeaveRequest\""
npm run db:push
```

---

## Out of scope (don't do these in this PR)

- Two-way applicant messaging UI in internal portal (deferred — `mailto:` is enough per user)
- User-configurable notification preferences page (deferred — role-based is enough)
- Migrating notification storage from per-user rows to a shared+receipts model (current schema is fine for this scale)
- OrgUnit `deletedAt` soft-delete (only add if Issue 5 diagnostic shows it's needed)
- Token storage migration (already deferred XL per CLAUDE.md)
- **Attendance machine API integration** — the docx mentioned "API address of the attendance machine" but user explicitly excluded this from scope. Tracked separately in [memory: Biometric integration (planned)](https://example.com). Needs device IP/creds/API docs + network topology decision first — do not start.

---

## Production safety contract (READ THIS BEFORE STARTING)

This PR touches production data paths and runs two `db:push` operations on a database that has no migration history. The following rules are **non-negotiable** — if Sonnet cannot satisfy any of them, stop and ask before continuing.

### Data-loss prevention rules

1. **NEVER run `db:push` on prod without diffing first.** `prisma db push` silently drops any column that exists in the DB but not in `schema.prisma`. Before running it on Linode:
   ```bash
   ssh linode "cd /opt/dashmani-platform && sudo -u postgres psql -d dashmani_prod -c '\\d \"announcements\"'"
   ssh linode "cd /opt/dashmani-platform && sudo -u postgres psql -d dashmani_prod -c '\\d \"leave_requests\"'"
   ```
   Compare the column list to the new `schema.prisma`. The diff must show **only additions** (new column names appearing in the schema that aren't in the DB). If a single existing column is missing from the schema → **stop and ask the user** before pushing. Don't assume "I'll add it back" — the column may already contain data.
2. **NEVER edit any line in `schema.prisma` you weren't explicitly asked to.** The schema edits in Issues 10 and 14 are surgical: add 1 field to `Announcement`, add 4 fields to `LeaveRequest`, add 1 inverse relation to `OrgUnit`. **Nothing else.** Do not "clean up" formatting, reorder fields, rename relations, or change any `@map` / `@@map` / `onDelete` / `@default` directive on any other model. A one-character accident in an unrelated model becomes a silent prod DROP.
3. **`db:push` runs LAST, manually, after deploy verification.** CI/CD does not run it (this is intentional — see CLAUDE.md). Sonnet should not attempt to run it from a script. After the GitHub Actions deploy completes and the build is verified, SSH in and run it by hand per the diff procedure above. If Sonnet's local DB needs the schema first, run `npm run db:push` in the local dev environment only — never as part of an automated step.
4. **Run `prisma db push --dry-run` first on prod** if available in the installed Prisma version. This prints the SQL it would execute without applying it. Eyeball it for any `DROP COLUMN` or `ALTER COLUMN ... TYPE` line — if either appears, **stop**.
5. **Take a logical backup before the first `db:push`** of this PR (one is enough, covers both schema changes if done together):
   ```bash
   ssh linode "sudo -u postgres pg_dump dashmani_prod | gzip > /root/backups/pre-portal-fixes-$(date +%Y%m%d-%H%M%S).sql.gz"
   ```
   Confirm the backup file is non-empty (`ls -lh /root/backups/`). Do this even if the diff looks clean — cheap insurance against the unknown.

### Behavior-change containment

6. **Issue 8 (require dueDate + accountId on create):** before splitting the validator, grep the entire repo for callers that POST to the task/content create endpoints:
   ```bash
   rg -n "tasks/create|/tasks\b.*POST|createTask\(|prisma\.task\.create" --type ts
   rg -n "content/create|/content\b.*POST|createContent\(|prisma\.contentPost\.create" --type ts
   ```
   If a cron job, seed script, or internal service creates tasks/content without these fields, those callers MUST be updated in the same PR — otherwise they'll start 400'ing or throwing in production. If a caller can't be updated cleanly, document why and **keep the field optional for that path** (e.g., service-level helper bypasses Zod by calling Prisma directly).
7. **Issue 9 (job application diagnostic):** if the diagnostic shows the row is NOT in the DB and the POST route has a swallowing `try/catch`, do not silently change error-handling behavior for *public* users. The fix should be: log the error server-side, return a structured 500 to the client only if the issue is genuinely server-side; otherwise return 400 with a non-leaky message. Confirm with the user before changing the error envelope shape for the public route.
8. **Issue 14 (SICK leave attachment requirement):** the validator refinement (`SICK + duration ≥ 3 days → attachment required`) applies to **new** leave requests only. **Do NOT** add the refinement to the update path in a way that retroactively invalidates existing PENDING leaves submitted before this PR — those rows must remain approvable/rejectable without an attachment. The cleanest way: only attach the refinement to `createLeaveRequestSchema`, never to `updateLeaveRequestSchema` or to admin approve/reject payloads.
9. **Issue 10 (team-targeted announcements):** when filtering recipients by `orgUnitId`, do NOT modify the behavior when `orgUnitId` is null/omitted — that path must remain a broadcast to all active employees, identical to today. Add a test (or manual verification step) that sending with no `orgUnitId` still notifies the same set of users as before.
10. **`PUT/PATCH` routes that gain new validators (Issues 6, 7, 8):** confirm the new validators are wired to the **route**, not the **service**. A validator change in `packages/shared` only blocks bad input if a route uses `validate(schema)` middleware. If the route currently has no validator (Issue 7 is exactly this case), the service call still accepts anything the route hands it.

### Pre-merge gates

11. **`npm run build` from repo root** must pass — not just `tsc --noEmit` per-app. Type errors that only surface at build time (Next.js's collectBuildTraces, Prisma client regeneration) will otherwise blow up in CI.
12. **Run the actual user flows on localhost** for the destructive paths:
    - Submit a leave request as an employee on HR portal → see it in admin leave page → approve it → confirm employee gets `LEAVE_APPROVED` notification, no one else does.
    - Send an announcement to "Everyone" and to a specific team → confirm recipient sets match expectation.
    - Edit an employee's name → save → re-read → name updated, roles unchanged.
    - Generate an offer letter → PDF downloads.
13. **Roll out in this order on prod** (matters because Issues 10 + 14 require `db:push`):
    1. Merge to `main` → GitHub Actions deploys code.
    2. SSH in, run the backup command (rule 5).
    3. Run the diff commands (rule 1).
    4. Run `npm run db:push` only if the diff is purely additive.
    5. `pm2 restart all` (deploy script already does this, but a second restart after `db:push` ensures Prisma client reloads).
    6. Smoke-test: send a test announcement, submit a test leave, generate a test offer letter.
14. **Rollback plan.** If anything breaks after the `db:push`:
    - Code rollback: `git revert <merge-commit> && git push origin main` re-deploys the previous version.
    - DB rollback: the schema changes are additive — old code ignores the new columns, so no DB rollback is required. The new columns just sit unused until the next forward deploy. **Don't** drop the new columns manually as part of a rollback — leave them in place.

### What Sonnet should refuse to do

- Run `npm run db:push` against a remote database from a script, even if seemingly safe.
- Edit any line in `schema.prisma` outside the two models being changed (Announcement, LeaveRequest, plus the inverse relation on OrgUnit).
- Touch `packages/db/prisma/seed.ts` to "match the new schema" — the seed is fully idempotent and the new fields are optional; it does not need updates.
- Touch any cron job's database write logic to "match" a new validator — fix the cron callers explicitly if rule 6 surfaces them, but don't preemptively rewrite cron logic.
- Run `git reset --hard`, `git push --force`, `git checkout .`, or any history-rewriting command on `main` or any feature branch with uncommitted work.
- Skip the `--no-verify` hook bypass on any commit.

---

## Why this plan is sized for Sonnet medium-thinking

- Every architectural decision is locked: routing matrix is fully specified, modal fix uses portals (no design call), leaderboard reuses the documented `employeeWhere` pattern, team count has a diagnostic-first algorithm with branch-by-result fix paths.
- All file paths are concrete. No "find the right place" wandering.
- No DB schema changes (unless Issue 5 diagnostic forces one, which is flagged).
- Verification steps are mechanical — no judgement required to confirm done.
