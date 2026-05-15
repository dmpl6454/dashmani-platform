# Internal Admin Portal — Error Log

**Purpose:** A living log of concrete errors observed in the internal admin portal — from static analysis, runtime reproduction, server logs, browser console, and user reports. Each entry is a self-contained record so anyone fixing the bug doesn't need to re-derive the context.

**How to use this file:**
- When a new error is observed, append an entry under "Open errors" using the template at the bottom.
- When an error is fixed, move it to "Resolved errors" with the resolving commit hash and verification notes.
- Pair each entry with the corresponding **Issue #** in [INTERNAL-PORTAL-AUDIT.md](./INTERNAL-PORTAL-AUDIT.md) when one exists.
- Keep entries terse but precise. Stack traces, request/response pairs, and reproduction steps go inside the entry, not in a separate file.

---

## Open errors

_(none — all known errors resolved as of 2026-05-15)_

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
