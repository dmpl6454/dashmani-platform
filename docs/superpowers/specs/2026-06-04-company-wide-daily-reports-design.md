# Company-Wide Daily Reports (Written) — Design

**Date:** 2026-06-04
**Author:** Tabish + Claude
**Status:** Approved — ready for implementation planning

---

## Problem

The company has two kinds of employees, and only one of them currently has a working daily-report path that admins can review:

1. **Link-posters** (social-media team) submit a **Link Report** (`/hr/report`): a list of links + optional notes. Admins review these day-to-day on the internal portal `/reports` pages. ✅ Works well.
2. **Non-link-posters** (designers, HR, ops, accounts, etc.) have **no links to submit**, and the Link Report form **hard-blocks submission with fewer than 1 link** (enforced at frontend, Zod validator, and service layer). They have **no appropriate place** to file a daily written report that admins can see.

There is an existing **Plan of Action (POA)** feature (`/hr/plan`) with fields `tasks / achievements / blockers / tomorrowPlan`. It *looks* like it was meant for this purpose, but **POA submissions are invisible to admins**: the `GET /admin/poa` endpoint exists and is fully functional (joins employee name/email, filters by employeeId/date), but **no internal-portal UI renders it**. The POA is effectively a write-only diary nobody reviews.

**Goal:** Give every employee a reliable way to file a written daily report that admins can see day-to-day — **without touching the load-bearing Link Report flow.**

---

## Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Field set | **What I did today** (required) · **What I'll do tomorrow** (optional) · **Notes** (optional, catch-all) | User's call. Lighter than POA's 4 fields; achievements/blockers fold into Notes. |
| Data model | **Separate** from Link Report (not unified) | Protects the Link Report form (Anish/Kanishka/draft/dedupe machinery). No risk to what works. |
| Build on | **Reuse & reshape the existing POA feature** | DailyPOA table + endpoints already exist; admin endpoint already built. Least code, no new table. |
| Who can view | **Admins + Super Admins only** (anyone with admin-dashboard / `employees.view` access) | Matches the existing gate on `GET /admin/poa`. No team-lead scoping for now. |
| Notes storage | **Reuse existing `blockers` column** (relabel in UI) | Zero schema change → **no `db:push` on prod**, no migration risk. |
| Non-submitters | **Show a clear "Not submitted today" panel** | The main reason an admin opens this page: spot gaps instantly. |

---

## Architecture

Two **separate, non-colliding** daily submissions:

|  | **Link Report** (existing — untouched) | **Daily Report (written)** — gains admin visibility |
|---|---|---|
| Who | Link-posters | **Everyone** |
| HR form | `/hr/report` — **NOT touched** | `/hr/plan` → relabeled "Daily Report" |
| Fields | links + notes | What I did today · What I'll do tomorrow · Notes |
| DB | `DailyReport` + `ReportLink` | `DailyPOA` (reused as-is) |
| API | existing report routes | `POST/GET /hr/poa`, `GET /hr/poa/:date` (existing) + `GET /admin/poa` (existing) |
| Admin UI | `/reports` (exists) | **`/daily-reports` (NEW)** |

The Link Report form and its validators are **out of scope** — not edited, not relaxed. This is the central safety constraint.

---

## Components

### 1. Database — `DailyPOA` (NO schema change, NO `db:push`)

Keep the table exactly as-is. Map the 3 UI fields onto existing columns:

| UI label | DB column | Notes |
|---|---|---|
| What I did today | `tasks` | already `String` (required) |
| What I'll do tomorrow | `tomorrowPlan` | already `String?` |
| Notes | `blockers` | **reused** — relabeled "Notes" in all UI; `achievements` column left unused |

Existing POA rows continue to work. The `@@unique([employeeId, date])` upsert key is unchanged (one report per employee per day).

> Cosmetic note for future devs: the DB column is `blockers` but the product concept is "Notes". This is intentional and documented here to avoid a prod migration. If a future change wants schema honesty, add a `notes` column then (additive, requires `db:push`).

### 2. HR portal form — `apps/hr/src/app/plan/page.tsx`

- Relabel page title `Plan of Action` → **`Daily Report`** (Topstrip title + sub).
- Slim form from 4 boxes to **3**: *What I did today\* · What I'll do tomorrow · Notes*.
  - Drop the `achievements` box from the UI; relabel the `blockers` box to **"Notes"**.
  - The two-column achievements/blockers grid becomes a single "Notes" card.
- Keep unchanged: today-only-editable / past-read-only policy, date navigation, "Go to Today", history list, upsert-on-save, `tasks` required guard.
- POST body: send `{ date, tasks, tomorrowPlan, blockers }` (blockers now carries Notes). Stop sending `achievements` (or send empty — harmless). **No API change required** since the endpoint already accepts these fields.
- Sidebar: relabel the HR-portal nav entry `Plan of Action` → `Daily Report` (verify both HR nav files per the "two nav files" lesson in CLAUDE.md).

### 3. API — minimal

- `POST /hr/poa`, `GET /hr/poa`, `GET /hr/poa/:date` — **unchanged** (already work).
- `GET /admin/poa` — **already exists**, gated on `authenticate` + `requirePermission("employees", "view")`, joins `employee {id,name,email}`, filters by `employeeId` & `date`, `take: 100`, ordered `date desc`.
  - **Optional enhancement (nice-to-have, can defer):** accept `from`/`to` range params for the admin page's range pills. If deferred, the admin page filters client-side within a single fetched date or recent window.
- **Non-submitters:** computed admin-side. Reuse the `employeeWhere` convention (`status: ACTIVE`, `deletedAt: null`, roles `some notIn [Super Admin, Admin]`) to get the active-employee denominator, minus today's submitters. Can be a small new endpoint `GET /admin/daily-reports/non-submitters?date=` OR computed in the page from an existing employee list + today's `/admin/poa?date=` result. Prefer computing from existing data first; add an endpoint only if needed.

### 4. Admin UI — NEW page `apps/internal/src/app/daily-reports/`

Mirror the existing `/reports` page conventions so it feels native:

- **Sidebar entry** under the "Analytics" section, next to "Reports" (label e.g. "Daily Reports"). Internal portal admin auth only.
- **Default view: Today**, company-wide.
- **"Not submitted today" panel** — prominent and self-explanatory: a clearly-labelled card listing active employees who have **not** filed a written report today, with a count (e.g. "12 of 47 employees haven't submitted today"). This is the headline signal.
- **Submitted reports list** — a card per submitting employee showing: employee name, date/time, *What I did today*, *What I'll do tomorrow*, *Notes* (each rendered only if present).
- **Date picker + range pills** — reuse the shared `_range.tsx` pill component from `/reports` for cross-page consistency.
- **Employee filter** — reuse the existing employee dropdown.
- Use `apiFetch` from `@/lib/api` (internal portal `accessToken`) — never a local helper.

---

## Data flow

**Employee submits (any role):**
`/hr/plan` form → `POST /hr/poa` (authenticateHr) → `prisma.dailyPOA.upsert` keyed on `(employeeId, date)` → stored in `tasks` / `tomorrowPlan` / `blockers`.

**Admin reviews:**
`/daily-reports` page → `GET /admin/poa?date=<today>` (authenticate + employees.view) → list of `{ employee, tasks, tomorrowPlan, blockers, date }` → rendered as cards. In parallel, active-employee list − submitters → "Not submitted today" panel.

---

## Error handling

- Future-date submission already rejected server-side (`poaDate > today` → 400). Keep.
- `tasks` required: keep the frontend `!tasks.trim()` guard and the server `if (!tasks) 400`.
- Admin page: graceful empty states — "No reports submitted today yet" and (if everyone submitted) "Everyone has submitted today ✅".
- Past dates remain read-only in the HR form (existing policy).

---

## Testing / verification

- `npx tsc --noEmit` on `apps/hr` and `apps/internal`; full `npm run build` (auth/shared imports surface only in full build).
- Manual: submit a Daily Report as a non-link-poster → confirm it appears on admin `/daily-reports` for today; confirm a non-submitter shows in the "Not submitted" panel; confirm past-date read-only still holds; confirm the Link Report flow is **byte-for-byte unchanged** (no edits to its files).
- Confirm **no `db:push`** is needed (no schema change).

---

## Explicitly NOT doing (YAGNI / safety)

- ❌ Not touching the Link Report form (`/hr/report`) or its validators/service.
- ❌ Not merging links + written reports into one model.
- ❌ Not adding team-lead scoping (admins/super-admins only).
- ❌ Not adding a DB table or running `db:push` on prod.
- ❌ Not removing the `achievements`/`blockers` columns from the schema (leave them; just stop surfacing `achievements`).

---

## Open follow-ups (future, out of scope)

- Optional: surface Link Report `notes` and these written reports together in one "Daily Activity" admin view.
- Optional: team-lead scoped visibility.
- Optional: schema-honesty migration to a real `notes` column.
- Optional: draft auto-save on the written form (mirroring the Link Report draft feature).
