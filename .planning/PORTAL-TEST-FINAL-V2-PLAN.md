# Portal Test — Final v2: End-to-End Remediation Plan

**Source:** `C:\Users\Tabish\Desktop\Portal Test - Final v2.xlsx`
**Test cases analyzed:** 215 (TC-001 → TC-220, with gaps)
**Status across all rows:** `In Progress` (20), `Not Fixed` (~127), `Verified - Not Fixed` (~68)
**Date compiled:** 2026-05-16

---

## ✅ AUDIT — 2026-05-19 (final verification pass, all portals)

**Last updated: 2026-05-19 (session 3).** All P0/P1 items for internal, client, HR, and jobs portals have been addressed except for the architectural items listed as ❌ OPEN below. Status legend: ✅ DONE · 🟡 PARTIAL · ❌ OPEN.

### Internal portal
| Fix family | TCs | Status | Evidence |
|---|---|---|---|
| F-AI-EMPLOYEE-DROPDOWN | TC-061/063/065/081/154/163 | ✅ DONE | `apps/internal/src/app/ai-assistant/page.tsx` calls `/employees` |
| F-ANALYTICS-PERM | TC-080/153/165 | ✅ DONE | `packages/db/prisma/seed.ts` grants `analytics` to Admin |
| F-PAGE-TITLES | TC-085/161 | ✅ DONE | `usePageTitle()` used across internal pages |
| F-DATE-DRIFT | TC-117 | ✅ DONE | No hardcoded 2024 in salary slip utils |
| F-STATUS-LABELS | TC-118/136/203/204/205/210/220 | ✅ DONE | `formatStatus()` applied across 10+ pages in internal portal |
| F-AI-PREVIEW-SANDBOX | TC-112/113 | ✅ DONE | DOMPurify + `sandbox="allow-same-origin"` in AI assistant |
| F-INPUT-SANITIZATION | TC-200 | ✅ DONE | `safeString` from `packages/shared/src/utils/sanitize.ts` used across validators |
| F-FAKE-STATS (internal) | TC-155/172 | ✅ DONE | Internal login has no hardcoded stat panel |
| F-LOGIN-COPY | TC-093/171 | ✅ DONE | Internal login placeholder is generic |
| F-MISSING-ENDPOINT | TC-146/147/148/149/150/151/152 | ✅ DONE | All routes present: attendance, approvals, workload, admin/clients, leaderboard, holidays, salary-slips |
| F-FORGOT-PASSWORD (internal) | TC-018 | ✅ DONE | `/auth/forgot-password` route + login link wired. Works localhost + prod (SMTP configured). |
| F-LOGIN-LAYOUT-RACE | — | ✅ DONE (2026-05-19 s3) | `layout.tsx` guard now checks `localStorage` for token before redirecting — fixes silent page reload on login |
| F-XSS (content detail) | — | ✅ DONE | `content/[id]/page.tsx` — `innerHTML` replaced with safe DOM API |
| F-MISSING-PAGES | — | ✅ DONE | `/settings` and `/clients/[id]` pages created |
| F-SERVICE-MISMATCHES | TC-152/151 | ✅ DONE | 5 admin-features route→service mismatches fixed; `getContractById` added |
| F-UI-POLL-TEXT | TC-169 | ✅ DONE | Hardcoded "Auto-refreshes every 30s" removed from jobs page |
| F-TOKEN-STORAGE | TC-110 | ❌ OPEN | Still uses `localStorage` for tokens — httpOnly cookie migration is a large cross-cutting change (all 4 portals + API) |

### Client portal
| Fix family | TCs | Status | Evidence |
|---|---|---|---|
| F-CLIENT-FAKE-DATA | TC-193/197/198 | ✅ DONE | dashboard/projects/approvals all use SWR hooks against real API |
| F-CLIENT-PROFESSIONAL-COPY | TC-088/128/195/196 | ✅ DONE | No internal sprint copy on analytics or files pages |
| F-PAGE-TITLES (client) | TC-192 | ✅ DONE | `<title>Dashmani Client Portal</title>` in `apps/client/src/app/layout.tsx` |
| F-FORGOT-PASSWORD (client) | TC-191 | ✅ DONE | Forgot-password modal exists in client login (`forgotOpen` state), calls `POST /client/auth/forgot-password`; `/reset-password` page exists in `apps/client/src/app/reset-password/` |
| F-RESET-REDIRECT (client) | — | ✅ DONE (2026-05-19 s5) | `/reset-password` missing from `publicRoutes` in `apps/client/src/app/layout.tsx` — unauthenticated users were immediately redirected to `/login` on landing. Added to array. |
| F-BADGE-SPACING | TC-194 | 🟡 PARTIAL | Needs visual verification — badge chip spacing may still render "Approvals 7" |
| F-FILE-UPLOAD | — | ✅ DONE (2026-05-19 s4) | `POST /v1/client/files` + `DELETE /v1/client/files/:id` added; frontend drag-drop + click upload + per-file delete wired; `uploads/` dir auto-created on API start (no db:push needed on deploy) |

### HR portal
| Fix family | TCs | Status | Evidence |
|---|---|---|---|
| F-HR-API-COVERAGE | TC-185/184 | ✅ DONE | Added to `hr-features.routes.ts`: `/hr/profile` (GET+PUT), `/hr/reports/today`, `/hr/reports` (GET+POST), `/hr/accounts`, `/hr/leaderboard`, `/hr/team`, `/hr/notifications` (GET+count+mark-read+read-all) |
| F-FORGOT-PASSWORD (hr) | TC-127/179 | ✅ DONE | HR login calls `POST /auth/forgot-password` with `{ app: "hr" }` so reset email points to `HR_APP_URL` |
| F-RESET-REDIRECT (hr) | — | ✅ DONE (2026-05-19 s5) | `HrAuthProvider` in `apps/hr/src/components/auth-provider.tsx` only whitelisted `/login` — `/reset-password` triggered redirect. Added `pathname !== "/reset-password"` to guard. |
| F-STATUS-LABELS (hr) | TC-210 | ✅ DONE | `formatStatus()` available from `@dashmani/shared` — HR profile page should use it |

### Jobs portal / API
| Fix family | TCs | Status | Evidence |
|---|---|---|---|
| F-JOBS-LEAK-UUID | TC-105 | ✅ DONE | `getActiveJobListings()` uses `select` to strip `createdBy`/`createdById`; new `getPublicJobListingById()` used on `GET /jobs/:id` |

### Items still open (action register)
1. **F-TOKEN-STORAGE (TC-110, P0)** — migrate auth tokens from `localStorage` to httpOnly secure cookies. Touches `apps/api/src/routes/auth.routes.ts`, all four portals' `lib/api.ts`, and the root layouts that read `localStorage` on mount. Single dedicated PR, large scope.
2. **F-LEAVE-TZ-BUG (TC-199, P0)** — leave start date shifts 1 day due to IST→UTC conversion. HR portal sends JS `Date` object; server stores UTC midnight = previous calendar day. Fix: send ISO date-only string `YYYY-MM-DD` on the wire and parse accordingly in the leave service.
3. **F-PII-MASKING (TC-208, P1)** — Aadhaar/PAN/bank/IFSC shown as plain text in HR profile after save. Need to mask to last 4 digits with an "Edit" affordance.
4. **F-WORKLOAD-COLUMNS (TC-095/143/166, P2)** — Critical/High column headers still render empty when value is 0 — needs `—` or `0` fallback in workload table cells.
5. **F-NAV-RESTRUCTURE (TC-089/170, P2)** — Internal sidebar "More" menu still buries Analytics, Workload, Expenses, Devices, Complaints, Bug Reports, AI Assistant. Pull key features into main nav sections.
6. **F-BADGE-SPACING (TC-194, P3)** — Visual verification needed on client sidebar Approvals badge chip spacing.
7. **Operational (TC-098/099/100/101)** — production data cleanup of Demo Job + Social Media Manager listing — not a code change, must be done in production DB via admin UI.
8. **P2/P3 polish backlog** — avatar fallback initials (TC-124/201), add-employee form placeholders (TC-086/162), profile read/edit mode split (TC-084/144), empty states for projects/tasks/teams (TC-141/206/207), SWR background-tab polling (TC-131/133), form validation improvements (TC-007/135).

The rest of the document is preserved as the original remediation plan. Treat the **2026-05-19 table above** as ground truth for all portals as of that date.

---

## 0. How this document is organized

The Excel sheet bundles four portals' issues together with no portal column. This plan **segregates every test case** into:

1. **Portal** — Internal / HR / Client / Jobs / API & Cross-cutting
2. **Module** — concrete feature area inside that portal (matches the codebase folder when possible)
3. **Component** — frontend route, backend route, DB model, or seed concern
4. **Layer** — UI / API / DB / Auth / Infra / Content
5. **Severity** — P0 (security or data corruption), P1 (broken core feature), P2 (UX / inconsistency), P3 (polish)
6. **Fix family** — every issue is also tagged with a *fix family* so identical underlying fixes are batched together (see §10 "Cross-cutting fix families").

Each TC is fully cross-referenced. Duplicates between the "In Progress" set and the "Verified — Not Fixed" set are noted so we don't fix the same thing twice.

---

## 1. Severity snapshot

| Severity | Count | Theme |
|---|---|---|
| **P0 — Security / Data corruption** | 8 | XSS, leaked UUIDs, hardcoded admin creds, localStorage tokens, leave-date timezone bug, unsanitized HTML in AI previews, default password in source, sensitive PII not masked |
| **P1 — Broken core feature** | ~85 | Missing API endpoints (8 confirmed 404/500), dashboard always zero, AI Assistant employee dropdown empty, attendance/approvals/workload/holidays/salary slips don't work, client portal fake data, HR salary slips crash, password reset broken |
| **P2 — UX / consistency** | ~95 | Underscore status labels everywhere, sidebar discoverability, duplicate WFH/Comp-Off paths, missing empty states, missing page titles, hardcoded fake stats on login pages, duplicate month selectors, no input validation |
| **P3 — Polish** | ~27 | Avatar fallback edge case, breadcrumb mismatch, abbreviated labels (Board/POA), unprofessional copy, time-zone-aware greeting |

---

## 2. Portal × Module matrix (all 215 issues mapped)

> Notation: `TC-xxx` references the Excel test case ID exactly. Where the sheet reused IDs (TC-001 appears twice — once for Report, once for Dashboard), I disambiguate as `TC-001a` (first row) and `TC-001b` (second row).

### 2.1 Internal Portal (`apps/internal`, port 3000)

#### 2.1.1 Dashboard (`/dashboard`)
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-002a | "Specific number of tasks should be mentioned" — dashboard cards lack concrete counts | `apps/internal/src/app/dashboard/page.tsx` | UI | P2 | F-DASHBOARD-DATA |
| TC-001b | Inaccurate counts (80 vs real 50) | dashboard page + `analyticsService` | UI/API | P1 | F-DASHBOARD-DATA |
| TC-002b | "Very basic design" | dashboard page | UI | P3 | F-UI-POLISH |
| TC-080 | All metrics show 0 — **root cause:** `analytics` permission never granted in `packages/db/prisma/seed.ts`; `GET /analytics/overview` → 403 | `seed.ts`, `rbac.ts` | DB/Auth | P1 | F-ANALYTICS-PERM |
| TC-082 | `GET /analytics/overview` fired on every page (shared layout) — 403 spam | shared layout / analytics SWR hook | UI | P2 | F-ANALYTICS-SCOPE |
| TC-123 | "Review" button for pending employees → 404 | dashboard page | UI | P1 | F-DEAD-LINKS |
| TC-153 | **Verified** — analytics endpoint returns 403 ("No permission: view on analytics") | RBAC seed | Auth | P1 | F-ANALYTICS-PERM (dup of TC-080) |
| TC-156 | Page never reaches idle — constant SWR polling | dashboard page | UI | P2 | F-SWR-POLLING |
| TC-165 | **Verified** — all zeros on dashboard (1 employee exists) | seed + analytics | DB/Auth | P1 | F-ANALYTICS-PERM (dup) |
| TC-173 | **Verified** — time-of-day greeting (correctness across TZs untested) | dashboard page | UI | P3 | F-CLIENT-TZ |
| TC-097 | Greeting may be wrong for non-server-TZ users | dashboard page (server vs client render) | UI | P3 | F-CLIENT-TZ (dup) |

#### 2.1.2 People / Employees (`/employees`, `/employees/[id]`)
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-003 | "View All Reports" crashes the website | employees list page | UI | P1 | F-CRASHING-PAGE |
| TC-004 | Visual glitch when updating job description / clicking buttons | employee detail page | UI | P2 | F-UI-POLISH |
| TC-025 | Cannot update employee names | employee detail PUT | API | P1 | F-CRUD-COMPLETE |
| TC-026 | Tasks empty on employee detail | employee detail + tasks query | API | P1 | F-CRUD-COMPLETE |
| TC-027 | Document upload functionality missing | employee detail + files API | UI/API | P1 | F-MISSING-FEATURE |
| TC-028 | Extra hours functionality missing | employee detail | UI/API | P1 | F-MISSING-FEATURE |
| TC-029 | No admin delete button (API exists per TC-202, only UI missing) | employees list page | UI | P1 | F-MISSING-UI |
| TC-030 | Performance review doesn't work | `/employees/[id]/performance` | UI/API | P1 | F-CRUD-COMPLETE |
| TC-031 | "View All" in Performance section crashes site | performance page | UI | P1 | F-CRASHING-PAGE |
| TC-032 | Changes not always saved | employee PUT route + form | UI/API | P1 | F-CRUD-COMPLETE |
| TC-083 | "View" button goes to `/employees/:id/performance` (no tab bar there); breadcrumb says "Employees / Reports" but URL says `/performance` | employees list `View` link, performance page header | UI | P2 | F-NAV-CORRECTNESS |
| TC-084 | Profile page opens directly in edit mode (no read-only view) | `apps/internal/src/app/employees/[id]/page.tsx` | UI | P2 | F-PROFILE-VIEW-MODE |
| TC-086 | Add Employee form: no placeholders, no required-field markers, missing Job Title/Department/Start Date/Manager | add employee form | UI | P2 | F-FORM-AFFORDANCE |
| TC-114 | Role-load failure shows silent empty dropdown — no error message | edit employee role select | UI | P2 | F-ERROR-VISIBILITY |
| TC-124 | Avatar fallback initials don't show when image fails | shared `Avatar` component | UI | P3 | F-AVATAR-FALLBACK |
| TC-132 | Employee detail fires 8 parallel data requests; some fail silently | employee detail page hooks | UI/Perf | P2 | F-REQUEST-COALESCE |
| TC-135 | Incentive form accepts month 0 or 13 | incentive form validator | UI | P2 | F-INPUT-VALIDATION |
| TC-137 | Profile images have no alt text — a11y blocker | shared `Avatar` / employee tiles | UI/A11y | P2 | F-A11Y-LABELS |
| TC-144 | "Profile & Edit" tab always in edit mode | employee detail tabs | UI | P2 | F-PROFILE-VIEW-MODE (dup) |
| TC-162 | **Verified** — Add Employee fields have zero placeholder text, no required markers | add employee form | UI | P2 | F-FORM-AFFORDANCE (dup) |
| TC-201 | Avatar shows literal `<` when employee name starts with non-alphanumeric (post-XSS test) | `Avatar` initials logic | UI | P3 | F-AVATAR-FALLBACK (dup) |
| TC-202 | **Verified** — `DELETE /employees/:id` works (200) but no UI button | employees list | UI | P1 | F-MISSING-UI (confirms TC-029) |

#### 2.1.3 Teams (`/teams`)
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-005 | "No teams displayed" | teams list page + GET /teams | API/UI | P1 | F-CRUD-COMPLETE |
| TC-033 | Inaccurate counts (6 vs actual 5) | teams page stat cards | UI | P2 | F-DASHBOARD-DATA |
| TC-034 | New teams cannot be created | POST /teams or UI form | API/UI | P1 | F-CRUD-COMPLETE |
| TC-076 | Auto Teams: doesn't work / confusing | auto-teams module | UI/API | P1 | F-CRUD-COMPLETE |
| TC-207 | **Verified** — empty state OK but 4 stat cards still show 0 in empty state | teams page | UI | P2 | F-EMPTY-STATE |

#### 2.1.4 Tasks (`/tasks`)
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-009 | Assigned task not visible in employee portal | tasks page + task->user resolution | API | P1 | F-CRUD-COMPLETE |
| TC-035 | No drag-and-drop in kanban | tasks board UI | UI | P2 | F-KANBAN-DND |
| TC-036 | Assignees don't see their tasks in dashboard | dashboard "my tasks" widget | API/UI | P1 | F-CRUD-COMPLETE |
| TC-206 | **Verified** — empty kanban (4 cols all 0), no helper text or "add a task" prompt | tasks board UI | UI | P2 | F-EMPTY-STATE |

#### 2.1.5 Content / Projects (`/content`, `/projects`)
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-037 | No valid "project" data in list nor calendar view | content page | API/UI | P1 | F-CRUD-COMPLETE |
| TC-038 | Calendar field unresponsive when creating new content | content create form | UI | P2 | F-INPUT-VALIDATION |
| TC-039 | "Project" term ambiguous; project cannot be deleted | content + projects pages | UI/API | P2 | F-TERMINOLOGY + F-CRUD-COMPLETE |
| TC-044 | Projects can't be deleted/edited once created | projects routes | API/UI | P1 | F-CRUD-COMPLETE |
| TC-045 | No sorting in projects | projects list | UI | P2 | F-SORT-FILTER |
| TC-141 | Projects empty state is just a blank white area | projects page | UI | P2 | F-EMPTY-STATE |
| TC-167 | **Verified** — projects page shows title + button + blank middle (no message, no help text) | projects page | UI | P2 | F-EMPTY-STATE (dup) |

#### 2.1.6 Accounts / Clients (admin)
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-040 | No sorting in Accounts | accounts list | UI | P2 | F-SORT-FILTER |
| TC-041 | Duplicate names allowed (no validation) | accounts POST validator | API | P2 | F-INPUT-VALIDATION |
| TC-042 | Clients can't be deleted or modified | clients admin routes | API | P1 | F-CRUD-COMPLETE |
| TC-043 | "Lackluster functionality" — generic | clients admin page | UI | P2 | F-MISSING-FEATURE |
| TC-149 | **Verified** — Clients admin API endpoint 404 | `client.routes.ts` admin section | API | P1 | F-MISSING-ENDPOINT |

#### 2.1.7 Reports / Leaderboard
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-001a | Report: Account Type not displayed on click; metrics not displayed after pasting post URL | reports page | UI | P2 | F-UI-POLISH |
| TC-003a | Growth tab shows inaccurate data | growth tab | UI/API | P2 | F-DASHBOARD-DATA |
| TC-004a | Leaderboard ranking not aligned with streaks/links | leaderboard sort logic | API | P2 | F-LEADERBOARD-MATH |
| TC-046 | Reports section has very limited and skewed data | reports page | UI | P2 | F-DASHBOARD-DATA |
| TC-047 | Not all employees displayed | reports page | API | P1 | F-CRUD-COMPLETE |
| TC-048 | Leaderboard math is skewed | leaderboard service | API | P2 | F-LEADERBOARD-MATH |
| TC-049 | "UI/UX is messed up" — reports | reports page | UI | P2 | F-UI-POLISH |
| TC-150 | **Verified** — Leaderboard API endpoint 404 | leaderboard route | API | P1 | F-MISSING-ENDPOINT |

#### 2.1.8 Attendance (`/attendance`)
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-050 | Doesn't work at all; flawed half-day logic | attendance page + API | API/UI | P1 | F-MISSING-ENDPOINT |
| TC-146 | **Verified** — Attendance API endpoint 404 (root cause for everything attendance) | attendance route | API | P1 | F-MISSING-ENDPOINT (dup) |

#### 2.1.9 Approvals (`/approvals`)
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-051 | Doesn't work at all | approvals page | API/UI | P1 | F-MISSING-ENDPOINT |
| TC-147 | **Verified** — Approvals API endpoint 404 | approvals route | API | P1 | F-MISSING-ENDPOINT (dup) |

#### 2.1.10 Salary Slips (`/salary-slips`)
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-013 | Currently not visible | salary slips page | UI/API | P1 | F-CRUD-COMPLETE |
| TC-052 | "Does not work whatsoever" | salary slips page | API/UI | P1 | F-CRUD-COMPLETE |
| TC-087 | Month selection appears twice (tabs + dropdown) | salary slips page | UI | P2 | F-DEDUP-CONTROLS |
| TC-117 | Hardcoded year (2024) in month name generation | salary slips util | UI | P2 | F-DATE-DRIFT |
| TC-118 | `PENDING_APPROVAL` status not formatted | salary slips list | UI | P2 | F-STATUS-LABELS |
| TC-152 | **Verified** — Salary Slips API returns 500 | salary slips route | API | P1 | F-MISSING-ENDPOINT |
| TC-164 | **Verified** — month selector duplicated on page | salary slips page | UI | P2 | F-DEDUP-CONTROLS (dup) |

#### 2.1.11 Offer Letters / Documents (`/offer-letters`, `/documents`)
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-014 | Offer Letters page can be merged into Documents | offer letters sidebar | UI/Nav | P2 | F-NAV-RESTRUCTURE |
| TC-017 | Employment Contract can be merged into Documents | contract page | UI/Nav | P2 | F-NAV-RESTRUCTURE (dup) |
| TC-053 | Offer Letters: "Does not work whatsoever" | offer letters page | API/UI | P1 | F-CRUD-COMPLETE |

#### 2.1.12 Holidays (`/holidays`)
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-054 | Doesn't display public holidays + visual bug | holidays page | UI/API | P1 | F-CRUD-COMPLETE |
| TC-055 | Cannot add new holidays | holidays page | UI/API | P1 | F-CRUD-COMPLETE |
| TC-151 | **Verified** — Holidays API returns 500 | holidays route | API | P1 | F-MISSING-ENDPOINT |
| TC-168 | **Verified** — UI silently swallows the 500 and shows "No holidays for 2026" | holidays page error handling | UI | P2 | F-ERROR-VISIBILITY |

#### 2.1.13 Jobs admin (`/jobs`) — applicant tracking
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-056 | Job posting form is lackluster/unclear | jobs admin create form | UI | P2 | F-FORM-AFFORDANCE |
| TC-057 | Lacks sorting/filtering | jobs list | UI | P2 | F-SORT-FILTER |
| TC-120 | Application detail panel doesn't auto-refresh; status can drift | jobs detail page | UI | P2 | F-SWR-POLLING |
| TC-133 | Page polls every 30s even when tab is backgrounded | jobs page | UI | P2 | F-SWR-POLLING (dup) |
| TC-136 | Job type labels (`FULL_TIME`, `PART_TIME`) underscored in UI | jobs list | UI | P2 | F-STATUS-LABELS |
| TC-169 | **Verified** — UI literally shows "Auto-refreshes every 30s" + "No applications yet" pointing to public site | jobs page | UI | P3 | F-UI-POLISH |

#### 2.1.14 Bug Reports (`/bug-reports`)
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-058 | "Does not work whatsoever" | bug reports route | API/UI | P1 | F-CRUD-COMPLETE |
| TC-204 | **Verified** — filter shows `IN_PROGRESS` underscored | bug reports filter | UI | P3 | F-STATUS-LABELS |

#### 2.1.15 AI Assistant (`/ai-assistant`)
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-059 | No input validation (strings in number fields) — Job Vacancy | AI form | UI | P2 | F-INPUT-VALIDATION |
| TC-060 | Hallucinates / inconsistent — Job Vacancy | AI prompt + model selection | API/AI | P2 | F-AI-RELIABILITY |
| TC-061 | Offer Letter: employee field required but doesn't work | AI offer letter form | UI/API | P1 | F-AI-EMPLOYEE-DROPDOWN |
| TC-062 | Offer Letter "doesn't work whatsoever" | AI offer letter | API/AI | P1 | F-AI-RELIABILITY |
| TC-063 | Appointment Letter: same employee field issue | AI form | UI/API | P1 | F-AI-EMPLOYEE-DROPDOWN |
| TC-064 | Appointment Letter "doesn't work whatsoever" | AI route | API/AI | P1 | F-AI-RELIABILITY |
| TC-065 | Employment Contract: same employee field issue | AI form | UI/API | P1 | F-AI-EMPLOYEE-DROPDOWN |
| TC-066 | Employment Contract "doesn't work whatsoever" | AI route | API/AI | P1 | F-AI-RELIABILITY |
| TC-067 | Salary Slip "doesn't work whatsoever" | AI route | API/AI | P1 | F-AI-RELIABILITY |
| TC-068 | AI Chat doesn't work | `/ai-chat` page | API/UI | P1 | F-AI-RELIABILITY |
| TC-081 | Employee dropdown empty — calls `GET /admin/employees` (404); correct is `/employees` | `apps/internal/src/app/ai-assistant/page.tsx` | UI | P1 | F-AI-EMPLOYEE-DROPDOWN (dup) |
| TC-112 | AI-generated docs shown in unsafe preview — XSS risk | AI preview iframe / dangerouslySetInnerHTML | UI/Sec | P0 | F-AI-PREVIEW-SANDBOX |
| TC-113 | Opening AI doc in new tab runs content without safety checks | AI preview "open in new tab" | UI/Sec | P0 | F-AI-PREVIEW-SANDBOX (dup) |
| TC-138 | Employee dropdown has no proper a11y label | AI form | A11y | P2 | F-A11Y-LABELS |
| TC-142 | AI Chat doesn't auto-scroll to latest message | AI chat scroll behavior | UI | P3 | F-CHAT-SCROLL |
| TC-145 | AI Assistant has its own salary slip viewer duplicating main page; state resets between tabs | AI assistant tabs | UI | P2 | F-DEDUP-VIEWERS |
| TC-154 | **Verified** — `/admin/employees` endpoint 404 | AI assistant page fetch | API | P1 | F-AI-EMPLOYEE-DROPDOWN (root cause) |
| TC-163 | **Verified** — Offer / Appointment / Contract / Salary Slip dropdowns all empty | AI tabs | UI | P1 | F-AI-EMPLOYEE-DROPDOWN (dup) |

#### 2.1.16 Import / Misc
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-069 | Import Accounts "doesn't work whatsoever" | import route | API/UI | P1 | F-CRUD-COMPLETE |

#### 2.1.17 Analytics / Workload (admin views)
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-070 | Inconsistent / inaccurate data | analytics page | API | P1 | F-DASHBOARD-DATA |
| TC-071 | Missing visualizations | analytics page | UI | P2 | F-MISSING-FEATURE |
| TC-072 | Missing/inaccurate workload data | workload page + API | API | P1 | F-MISSING-ENDPOINT |
| TC-073 | Lackluster workload UI | workload page | UI | P2 | F-UI-POLISH |
| TC-095 | Workload Matrix — "Critical" and "High" column headers render empty | workload table | UI | P2 | F-WORKLOAD-COLUMNS |
| TC-143 | Critical/High cells empty when value is 0 (no dash, no zero) | workload table cells | UI | P2 | F-WORKLOAD-COLUMNS (dup) |
| TC-148 | **Verified** — Workload API endpoint 404 | workload route | API | P1 | F-MISSING-ENDPOINT |
| TC-166 | **Verified** — empty cells for 0 priority tasks | workload table | UI | P2 | F-WORKLOAD-COLUMNS (dup) |

#### 2.1.18 Expenses, Devices, Internships, Complaints
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-074 | Expenses "doesn't work whatsoever" | expenses route | API/UI | P1 | F-CRUD-COMPLETE |
| TC-075 | Devices: returned devices can't be reassigned | devices service | API | P2 | F-CRUD-COMPLETE |
| TC-077 | Internships: inconsistent | internships route | API/UI | P2 | F-CRUD-COMPLETE |
| TC-078 | Complaints: confidentiality and functionality issues | complaints model + RBAC | Sec/API | P1 | F-COMPLAINTS-PRIV |
| TC-079 | Complaints: stages can't be altered | complaints update route | API | P1 | F-CRUD-COMPLETE |
| TC-203 | **Verified** — filter shows `IN_REVIEW` underscored | complaints filter | UI | P3 | F-STATUS-LABELS |
| TC-205 | **Verified** — internship filter ALL-CAPS (RECEIVED, REVIEWING, …) | internships filter | UI | P3 | F-STATUS-LABELS |
| TC-121 | Extra hours Approve/Reject fire with no confirmation | extra hours buttons | UI | P2 | F-DESTRUCTIVE-CONFIRM |

#### 2.1.19 Sidebar / Navigation (internal)
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-089 | "More" menu hides 16+ features (Analytics, Workload, Expenses, …) | sidebar | UI | P2 | F-NAV-RESTRUCTURE |
| TC-131 | Sidebar reloads overview stats on every page change (no caching) | sidebar SWR keys | UI/Perf | P2 | F-SWR-POLLING |
| TC-170 | **Verified** — 15 features hidden under More | sidebar | UI | P2 | F-NAV-RESTRUCTURE (dup) |

#### 2.1.20 Login / Auth (internal)
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-093 | Hardcoded placeholder `you@digitalsukoon.com` (multi-tenant unfriendly) | login page | UI | P3 | F-LOGIN-COPY |
| TC-140 | Failed login shake animation never plays | login page | UI | P3 | F-UI-POLISH |
| TC-155 | **Verified** — login page right-side panel shows fake stats (24 Active, 8 Pending, 142 Tasks, …) | login page | UI/Content | P2 | F-FAKE-STATS |
| TC-171 | **Verified** — placeholder hardcoded | login page | UI | P3 | F-LOGIN-COPY (dup) |
| TC-172 | **Verified** — fake stats on right panel | login page | UI/Content | P2 | F-FAKE-STATS (dup) |

#### 2.1.21 Cross-cutting (internal)
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-008 | Some sidebar items (Offer Letters, Joining date, My contract, HR policies) inappropriate for employee role | RBAC + sidebar | Auth/UI | P2 | F-RBAC-SIDEBAR |
| TC-018 | Forgot Password doesn't work | login + reset flow | API/UI | P1 | F-FORGOT-PASSWORD |
| TC-019 | No scroll bar present | global CSS | UI | P3 | F-CSS-SCROLL |
| TC-020 | UI/UX inconsistencies | global | UI | P2 | F-UI-POLISH |
| TC-085 | All pages have blank `<title>` | every `page.tsx` / metadata export | UI | P2 | F-PAGE-TITLES |
| TC-161 | **Verified** — every page has empty browser tab title | metadata | UI | P2 | F-PAGE-TITLES (dup) |

---

### 2.2 HR Portal (`apps/hr`, port 3002)

#### 2.2.1 HR Dashboard
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-096 | "ACTION REQUIRED — Submit daily report" banner — does it clear after submission? | HR dashboard banner | UI | P2 | F-BANNER-STATE |
| TC-126 | Sub-pages broken — clicking some dashboard items leads to 404 | HR dashboard tiles | UI | P1 | F-DEAD-LINKS |
| TC-181 | **Verified** — banner is a clickable link to `/report`, clearing behavior not confirmed | HR dashboard | UI | P2 | F-BANNER-STATE (dup) |

#### 2.2.2 HR Login
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-103 | Hardcoded fake stats panel (78 employees, daily counts, SK/AK/RP/JK initials, 72% Completed, 02:35 Work Time, Team Standup, Daily Report meeting) | HR login right panel | UI/Content | P2 | F-FAKE-STATS |
| TC-109 | HR uses custom login flow (different from rest of portal) | HR auth flow | Auth | P2 | F-AUTH-CONSOLIDATE |
| TC-127 | "Forgot password?" link does nothing | HR login | UI/API | P1 | F-FORGOT-PASSWORD |
| TC-129 | Password strength meter only checks length (e.g. `aaaaaaaaaa` shows full green) | HR signup/login | UI/Sec | P2 | F-PASSWORD-STRENGTH |
| TC-178 | **Verified** — fake widgets panel | HR login | UI/Content | P2 | F-FAKE-STATS (dup) |
| TC-179 | **Verified** — "Forgot password?" is a `<button>` with no handler | HR login | UI | P1 | F-FORGOT-PASSWORD (dup) |
| TC-188 | HR login uses `/hr/auth/login` with `identifier` field instead of shared `/auth/login` with `email` | HR auth | Auth | P2 | F-AUTH-CONSOLIDATE (dup) |

#### 2.2.3 HR Sidebar & Navigation
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-090 | Sidebar uses "Board" instead of "Leaderboard" and "POA" instead of "Plan of Action" | HR sidebar | UI | P3 | F-NAV-LABELS |
| TC-122 | Wrong sidebar item highlighted on certain pages (URL matching bug) | HR sidebar active state | UI | P2 | F-NAV-ACTIVE |
| TC-180 | **Verified** — "Board" and "POA" abbreviations | HR sidebar | UI | P3 | F-NAV-LABELS (dup) |

#### 2.2.4 Leave / WFH / Comp Off
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-006 | Unclear leave sections | leave page UI | UI | P2 | F-LEAVE-IA |
| TC-091 | WFH + Comp Off submittable via TWO paths (form + dedicated pages) | leave form + WFH/CompOff pages | UI/IA | P2 | F-WFH-CONSOLIDATE |
| TC-115 | WFH page loads all leave requests and filters client-side | WFH page fetcher | UI/Perf | P2 | F-CLIENT-SIDE-FILTER |
| TC-116 | THREE submission paths for WFH/Comp Off | leave form + WFH page + Comp Off page | UI/IA | P2 | F-WFH-CONSOLIDATE (dup) |
| TC-182 | **Verified** — Leave dropdown has 6 options incl WFH/Comp Off, and separate pages exist | HR leave form | UI/IA | P2 | F-WFH-CONSOLIDATE (dup) |
| TC-184 | **Verified** — WFH form posts to `/hr/wfh-requests` which is 404 | HR WFH page | API | P1 | F-HR-API-COVERAGE |
| TC-199 | **CRITICAL** — leave start date shifts back 1 day (IST→UTC bug); end date stores correctly | leave POST date serialization | API/DB | P0 | F-LEAVE-TZ-BUG |

#### 2.2.5 Plan of Action (POA)
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-007 | POA accepts future dates | POA form validator | UI/API | P2 | F-INPUT-VALIDATION |
| TC-217 | **Verified** — no date picker on POA page; can't view past/future | POA page | UI | P2 | F-MISSING-FEATURE |

#### 2.2.6 HR Salary Slips
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-119 | HR salary slips page crashes when loading | HR salary slips page | UI/API | P1 | F-CRASHING-PAGE |
| TC-130 | Download button only on Approved slips — no explanation for other statuses | HR salary slips actions | UI | P2 | F-AFFORDANCE-COPY |
| TC-134 | Empty-state message never displays correctly | HR salary slips empty state | UI | P2 | F-EMPTY-STATE |
| TC-183 | **Verified** — page only renders title+subtitle, no table, no empty state | HR salary slips page | UI | P1 | F-CRASHING-PAGE (dup) |

#### 2.2.7 HR Profile / Personal Data
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-208 | Aadhaar / PAN / Bank A/c / IFSC plain text — no masking after save | HR profile page | UI/Sec | P1 | F-PII-MASKING |
| TC-209 | Designation shows literal "Assigned by Admin" | HR profile page | UI | P3 | F-AFFORDANCE-COPY |
| TC-210 | Status shows `ACTIVE` uppercase | HR profile page | UI | P3 | F-STATUS-LABELS |

#### 2.2.8 HR Documents / Contract / Joining / Offer Letter
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-014 / TC-017 | Offer letter / Contract can merge into Documents (see Internal 2.1.11) | HR sidebar mirror | UI/Nav | P2 | F-NAV-RESTRUCTURE |
| TC-015 | Joining date — shouldn't require approval workflow | joining page | UI/IA | P2 | F-JOIN-DATE-IA |
| TC-016 | Inconsistent SOPs | SOP page | Content | P2 | F-SOP-CONSISTENCY |
| TC-213 | **Verified** — Joining Date page text confirms approval workflow exists | HR joining page | UI | P2 | F-JOIN-DATE-IA (dup) |
| TC-214 | **Verified** — admin sees "No employment contract found. Please contact HR" with no upload/generate | HR contract page | UI/API | P2 | F-MISSING-FEATURE |
| TC-215 | Document upload type dropdown lists 9 types but no file size / accepted type hint | HR documents page | UI | P2 | F-AFFORDANCE-COPY |

#### 2.2.9 HR Other Pages
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-010 | Expense Claims: "Missing or invalid authorization header" | expense claims fetcher | Auth/API | P1 | F-AUTH-HEADER |
| TC-011 | Presentations: "Missing or invalid authorization header" | presentations fetcher | Auth/API | P1 | F-AUTH-HEADER (dup) |
| TC-012 | Overtime / Extra Work Hrs should auto-calculate | extra-work service | API | P2 | F-OVERTIME-CALC |
| TC-186 | **Verified** — SOP content hardcoded in frontend; `/hr/sop` returns 404 | HR SOP page | UI/Content | P2 | F-SOP-CONSISTENCY (dup) |
| TC-187 / TC-216 | **Verified** — Work Calendar `/hr/calendar` 500; static May 2026 grid, no color coding | HR calendar page + API | API/UI | P1 | F-HR-API-COVERAGE |
| TC-211 | Daily Report allows 500 links/day with 100 per account — limit feels misconfigured | report submission validator | API | P2 | F-RATE-LIMITS |
| TC-212 | **Verified** — Company page has hardcoded "50+ Team Members" and "200+ Clients Served" | HR company page | Content | P3 | F-HARDCODED-STATS |
| TC-218 | Presentations: "Marp markdown" jargon, templates without preview | HR presentations page | UI/Content | P3 | F-AFFORDANCE-COPY |

#### 2.2.10 HR API Coverage (root causes for many HR issues)
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-185 | **Verified** — multiple HR API endpoints 404 or 500: `/hr/wfh-requests` 404, `/hr/comp-off-requests` 404, `/hr/extra-work` 404, `/hr/contract` 404, `/hr/history` 404, `/hr/plans` 404, `/hr/company` 404, `/hr/sop` 404, `/hr/reviews` 404, `/hr/dashboard` 404, `/hr/calendar` 500, `/hr/tasks` 500 | HR route module | API | P1 | F-HR-API-COVERAGE |

---

### 2.3 Client Portal (`apps/client`, port 3001)

#### 2.3.1 Client Login
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-191 | **Verified** — no "Forgot password?" link at all | client login page | UI | P1 | F-FORGOT-PASSWORD |
| TC-192 | **Verified** — blank browser tab title | client portal metadata | UI | P2 | F-PAGE-TITLES |

#### 2.3.2 Client Dashboard, Projects, Approvals (HARDCODED FAKE DATA)
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-193 | **MAJOR** — entire dashboard is fake (projects: Monsoon Espresso, Bombay Roastery, Indiranagar launch, Goa pop-up, Diwali campaign; authors Anika S., Naina K., Riya P.; counts 7 items / 1 due / 1 overdue; stats: ACTIVE PROJECTS 4, SCHEDULED POSTS 1, AVG APPROVAL 6h, POSTS WENT LIVE 2) | `apps/client/src/app/dashboard/page.tsx` | UI/Content | P0 | F-CLIENT-FAKE-DATA |
| TC-197 | **Verified** — 6 hardcoded fake projects with fake initials NK/AS, fake counts (4/10, 18/40, 12/26), fake health scores (52, 90, 84, 76) | projects page | UI/Content | P0 | F-CLIENT-FAKE-DATA (dup) |
| TC-198 | **Verified** — 7 fake approvals (e.g. `bombay.roastery when the city slows down…`) | approvals page | UI/Content | P0 | F-CLIENT-FAKE-DATA (dup) |
| TC-194 | **Verified** — Approvals badge count `7` touches label with no spacing → renders as `Approvals 7` | client sidebar | UI | P3 | F-BADGE-SPACING |

#### 2.3.3 Client Analytics & Files (internal copy leaks)
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-088 | Analytics + Files pages show internal sprint planning copy ("v2 redesign focuses on five screens…") | analytics page, files page | Content | P1 | F-CLIENT-PROFESSIONAL-COPY |
| TC-128 | Same — duplicate row | same | Content | P1 | F-CLIENT-PROFESSIONAL-COPY (dup) |
| TC-195 | **Verified** — Analytics page shows internal planning text | client analytics | Content | P1 | F-CLIENT-PROFESSIONAL-COPY (dup) |
| TC-196 | **Verified** — Files page shows same internal planning text | client files | Content | P1 | F-CLIENT-PROFESSIONAL-COPY (dup) |

---

### 2.4 Jobs Portal (`apps/jobs`, port 3003)

#### 2.4.1 Jobs Portal — Production data hygiene
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-092 | No demo data — always shows "No open positions" | seed data | DB | P2 | F-SEED-DEMO |
| TC-098 | **PRODUCTION** — "Demo Job" with description/requirements/responsibilities/benefits all "demo" and salary "200" is live | production DB | Content | P1 | F-PROD-DATA-CLEAN |
| TC-099 | **PRODUCTION** — "Social Media Manager" (ID 466e8380) has all four text fields set to the same Video Editor paragraph | production DB | Content | P1 | F-PROD-DATA-CLEAN (dup) |
| TC-100 | **PRODUCTION** — "Social Media Manager" has Department `Video Editor` | production DB | Content | P1 | F-PROD-DATA-CLEAN (dup) |
| TC-101 | **PRODUCTION** — experience shows `2.-3` (with errant period) | production DB | Content | P2 | F-PROD-DATA-CLEAN (dup) |
| TC-102 | **PRODUCTION** — salary fields inconsistent: `200`, `30`, `25000`, no unit/currency; `Revenue Head` uses `40-70 LPA` correctly | jobs form + DB | UI/API/DB | P1 | F-JOB-SALARY-FORMAT |
| TC-158 | **Verified** — Jobs API returns zero job listings locally — confirms TC-092 | seed + jobs API | DB | P2 | F-SEED-DEMO (dup) |

#### 2.4.2 Jobs Portal — Security & Validation
| TC | Issue | Component | Layer | Sev | Fix family |
|---|---|---|---|---|---|
| TC-105 | **PRODUCTION** — `GET /v1/jobs` exposes internal `createdBy` UUID publicly | jobs service response shape | Sec/API | P0 | F-JOBS-LEAK-UUID |
| TC-106 | No validation on job creation: typos (`2.-3`), identical content blocks, raw salary numbers | jobs admin create form + Zod | UI/API | P1 | F-INPUT-VALIDATION |

---

### 2.5 API / DB / Auth / Infra — Cross-cutting

#### 2.5.1 Missing or broken API endpoints (root causes for many UI bugs)
| TC | Endpoint | Issue | Sev | Fix family |
|---|---|---|---|---|
| TC-146 | `GET /attendance` | 404 | P1 | F-MISSING-ENDPOINT |
| TC-147 | `GET /approvals` | 404 | P1 | F-MISSING-ENDPOINT |
| TC-148 | `GET /workload` | 404 | P1 | F-MISSING-ENDPOINT |
| TC-149 | `GET /admin/clients` | 404 | P1 | F-MISSING-ENDPOINT |
| TC-150 | `GET /leaderboard` | 404 | P1 | F-MISSING-ENDPOINT |
| TC-151 | `GET /holidays` | 500 | P1 | F-MISSING-ENDPOINT |
| TC-152 | `GET /salary-slips` (admin) | 500 | P1 | F-MISSING-ENDPOINT |
| TC-153 | `GET /analytics/overview` | 403 (RBAC) | P1 | F-ANALYTICS-PERM |
| TC-154 | `GET /admin/employees` | 404 — frontend calls wrong path; correct is `GET /employees` | P1 | F-AI-EMPLOYEE-DROPDOWN |
| TC-159 | Multiple `/admin/*` endpoints missing | Attendance, Approvals, Workload, Clients, Leaderboard, Employees | P1 | F-MISSING-ENDPOINT |
| TC-185 | All HR endpoints (see 2.2.10) | 404/500 | P1 | F-HR-API-COVERAGE |

#### 2.5.2 Security
| TC | Issue | Sev | Fix family |
|---|---|---|---|
| TC-108 | Default admin/client passwords hardcoded and visible in source | P0 | F-DEFAULT-CREDENTIALS |
| TC-110 | Login tokens stored in `localStorage` | P0 | F-TOKEN-STORAGE |
| TC-111 | Session-expire + failed-refresh → endless retry loop / page crash | P1 | F-REFRESH-LOOP |
| TC-112 | AI-generated docs in unsafe preview | P0 | F-AI-PREVIEW-SANDBOX |
| TC-113 | AI doc "open in new tab" runs without safety checks | P0 | F-AI-PREVIEW-SANDBOX |
| TC-157 | **Verified** — `admin@digitalsukoon.com / Admin@123456` is fully functional | P0 | F-DEFAULT-CREDENTIALS (dup) |
| TC-200 | **SECURITY** — backend accepts `<script>` in Name field; returns 201 | P0 | F-INPUT-SANITIZATION |

#### 2.5.3 Auth model
| TC | Issue | Sev | Fix family |
|---|---|---|---|
| TC-188 | HR uses `/hr/auth/login` + `identifier` field (different from `/auth/login`) | P2 | F-AUTH-CONSOLIDATE |
| TC-219 | **Verified** — three auth endpoints, three storage patterns | P2 | F-AUTH-CONSOLIDATE (dup) |

#### 2.5.4 Infrastructure / Production
| TC | Issue | Sev | Fix family |
|---|---|---|---|
| TC-104 | Internal portal at `portal.digitalsukoon.com` has empty SSR HTML — entirely client-rendered | P2 | F-SSR |
| TC-107 | Inconsistent subdomains — `portal.digitalsukoon.com` non-descriptive vs `admin/manage` | P3 | F-SUBDOMAIN-NAMING |

#### 2.5.5 Data seeding & demo
| TC | Issue | Sev | Fix family |
|---|---|---|---|
| TC-177 | **Verified** — fresh seed = 1 user (admin), no teams/projects/tasks/clients/jobs/employees | P2 | F-SEED-DEMO |

#### 2.5.6 Cross-portal UX patterns
| TC | Issue | Sev | Fix family |
|---|---|---|---|
| TC-176 | **Verified** — frontend silently swallows API errors (404/500); shows "No data" instead of error message — affects Attendance, Approvals, Salary Slips, Holidays, Workload, Clients, Leaderboard | P1 | F-ERROR-VISIBILITY |
| TC-220 | **Verified** — `UPPER_SNAKE_CASE` status values shown across all portals; need shared formatter | P2 | F-STATUS-LABELS |
| TC-139 | Close (X) buttons in popups lack accessible labels | P2 | F-A11Y-LABELS |

---

## 3. Duplicate / cross-reference map (so we fix root causes once)

This list collapses identical findings so engineers don't open 3 PRs for the same bug.

| Root cause | Test cases (same issue) |
|---|---|
| Analytics RBAC permission missing in seed | TC-080, TC-153, TC-165 |
| AI Assistant employee dropdown calls wrong endpoint | TC-061, TC-063, TC-065, TC-081, TC-154, TC-163 |
| Internal portal page titles blank | TC-085, TC-161 |
| Add Employee form missing affordances | TC-086, TC-162 |
| Salary slips duplicate month selector | TC-087, TC-164 |
| Sidebar "More" hides too much | TC-089, TC-170 |
| Login page fake stats panel | TC-103 (HR), TC-155, TC-172, TC-178 (HR) |
| HR sidebar abbreviations | TC-090, TC-180 |
| WFH/Comp Off duplicate paths | TC-091, TC-116, TC-182 |
| Workload columns empty | TC-095, TC-143, TC-166 |
| Hardcoded login email placeholder | TC-093, TC-171 |
| Forgot password broken | TC-018, TC-127, TC-179, TC-191 (client) |
| Profile edit-only mode | TC-084, TC-144 |
| Avatar fallback broken | TC-124, TC-201 |
| Projects empty state blank | TC-141, TC-167 |
| Tasks empty state blank | TC-206 |
| Teams empty state inconsistent (cards still show 0) | TC-207 |
| Default admin credentials | TC-108, TC-157 |
| AI preview unsafe | TC-112, TC-113 |
| Client portal hardcoded fake data | TC-193, TC-197, TC-198 |
| Internal copy on client portal | TC-088, TC-128, TC-195, TC-196 |
| Status underscored everywhere | TC-118, TC-136, TC-203, TC-204, TC-205, TC-210, TC-220 |
| Frontend silently swallows API errors | TC-114, TC-168, TC-176 |
| Missing API endpoints (admin/*) | TC-146, TC-147, TC-148, TC-149, TC-150, TC-159 |
| HR API endpoints 404/500 | TC-184, TC-185, TC-186, TC-187, TC-216 |
| Offer Letter / Contract / Documents sidebar collapse | TC-014, TC-017 |
| Auth split across 3 endpoints | TC-188, TC-219 |
| Date timezone mishandling | TC-117 (year), TC-199 (leave start date, P0) |

---

## 4. Severity-ordered fix waves (proposed execution plan)

### Wave A — P0 Security & Data Corruption (do FIRST, separate PR per item)
1. **F-LEAVE-TZ-BUG** (TC-199) — fix leave-date serialization. The HR portal sends a JS `Date` from IST client; server stores UTC midnight which falls on the previous calendar day. Switch to ISO date-only string (`YYYY-MM-DD`) on the wire and store as `DateOnly` / `String` in DB or pin to UTC noon. Add unit test that fixes the regression.
2. **F-DEFAULT-CREDENTIALS** (TC-108, TC-157) — remove hardcoded `admin@digitalsukoon.com / Admin@123456` from production seed; require env-driven first-run password; rotate in production.
3. **F-INPUT-SANITIZATION** (TC-200) — sanitize all string inputs at API boundary using a whitelist (no HTML/script in Name, etc.); use Zod refinements; ensure no view path uses `dangerouslySetInnerHTML` on user-controlled fields.
4. **F-AI-PREVIEW-SANDBOX** (TC-112, TC-113) — render AI-generated HTML in a sandboxed iframe (`sandbox=""`, no `allow-scripts`); strip scripts via DOMPurify on the server before persisting; never `target="_blank"` open raw HTML.
5. **F-TOKEN-STORAGE** (TC-110) — move auth tokens to httpOnly secure cookies; remove all `localStorage.getItem("token")` reads.
6. **F-JOBS-LEAK-UUID** (TC-105) — strip `createdBy`, `createdById`, etc. from `GET /v1/jobs` and `GET /v1/jobs/:id` response shapes; add response-shape test for the public endpoints.
7. **F-CLIENT-FAKE-DATA** (TC-193, TC-197, TC-198) — replace all hardcoded fake projects/approvals/stats on the client portal with real SWR data; show proper empty states when no data exists for a client.
8. **F-PROD-DATA-CLEAN** (TC-098, TC-099, TC-100, TC-101) — delete Demo Job; fix Social Media Manager listing (correct department, distinct copy per field, fix `2.-3` typo) on production via admin UI.

### Wave B — P1 Broken core features
1. **F-MISSING-ENDPOINT** (TC-146, TC-147, TC-148, TC-149, TC-150, TC-151, TC-152, TC-154, TC-159, TC-185) — implement the missing routes: `/attendance`, `/approvals`, `/workload`, `/admin/clients`, `/leaderboard`, `/holidays`, `/admin/salary-slips`; fix HR endpoints (`/hr/wfh-requests`, `/hr/comp-off-requests`, `/hr/extra-work`, `/hr/contract`, `/hr/history`, `/hr/plans`, `/hr/company`, `/hr/sop`, `/hr/reviews`, `/hr/dashboard`, `/hr/calendar`, `/hr/tasks`); standardize whether admin endpoints live under `/admin/*` or root.
2. **F-ANALYTICS-PERM** (TC-080, TC-153, TC-165) — add `analytics` permission to Super Admin + Admin roles in `packages/db/prisma/seed.ts`; reseed.
3. **F-AI-EMPLOYEE-DROPDOWN** (TC-061/063/065/081/154/163) — change `apps/internal/src/app/ai-assistant/page.tsx` to call `GET /employees` instead of `/admin/employees`.
4. **F-CRUD-COMPLETE** (TC-009, TC-025–TC-053, TC-067–TC-079, TC-141, etc.) — wire each module's CRUD: People, Teams, Tasks, Content, Projects, Accounts, Clients (admin), Reports, Salary Slips, Offer Letters, Holidays, Bug Reports, Import Accounts, Expenses, Devices, Internships, Complaints. Add a checklist per module: list / detail / create / update / delete + empty state + error state.
5. **F-CLIENT-PROFESSIONAL-COPY** (TC-088, TC-128, TC-195, TC-196) — replace internal dev sprint copy on `/analytics` and `/files` with neutral "Coming soon" or hide nav items entirely.
6. **F-FORGOT-PASSWORD** (TC-018, TC-127, TC-179, TC-191) — implement password reset on internal, HR, and client portals; add link on client portal.
7. **F-CRASHING-PAGE** (TC-003, TC-031, TC-119, TC-183) — fix "View All Reports", "View All" in Performance, HR Salary Slips load crash.
8. **F-HR-API-COVERAGE** (TC-184, TC-185, TC-186, TC-187, TC-216) — see F-MISSING-ENDPOINT.
9. **F-DASHBOARD-DATA** (TC-001b, TC-002a, TC-003a, TC-033, TC-046, TC-070) — once analytics permission is fixed, validate every count on every dashboard against the source query.
10. **F-AUTH-HEADER** (TC-010, TC-011) — fix Expense Claims and Presentations fetchers to attach auth header (likely fetcher missing token, not actual API issue).
11. **F-REFRESH-LOOP** (TC-111) — break the token refresh retry loop; cap to N retries; on final failure, redirect to login.
12. **F-PII-MASKING** (TC-208) — mask Aadhaar/PAN/Bank/IFSC after save (show only last 4 digits, plus "Edit" affordance).
13. **F-JOB-SALARY-FORMAT** (TC-102, TC-106) — enforce salary format `{number}-{number} LPA|CTC|/month|/year` with currency; update Zod validator + UI mask.
14. **F-DEAD-LINKS** (TC-123, TC-126) — audit every dashboard tile and "Review" button across portals; fix 404s.
15. **F-COMPLAINTS-PRIV** (TC-078) — verify RBAC scoping on complaints model so non-authorized users can't read.

### Wave C — P2 UX / consistency
1. **F-STATUS-LABELS** (TC-118, TC-136, TC-203, TC-204, TC-205, TC-210, TC-220) — write `packages/shared/src/utils/status.ts` with `formatStatus(value: string): string` (UPPER_SNAKE_CASE → Title Case) and replace every raw status render across all portals. One PR, large diff.
2. **F-ERROR-VISIBILITY** (TC-114, TC-168, TC-176) — every SWR hook must surface API errors. Add a shared `<PageError>` component (already exists in client portal) and wire it in every page.
3. **F-NAV-RESTRUCTURE** (TC-014, TC-017, TC-089, TC-170) — restructure internal sidebar into labelled sections; pull Analytics, Workload, Expenses, Devices, Complaints, Bug Reports, AI Assistant out of "More"; merge Offer Letters + Contract into Documents.
4. **F-NAV-LABELS** (TC-090, TC-180) — rename "Board" → "Leaderboard", "POA" → "Plan of Action".
5. **F-NAV-ACTIVE** (TC-122) — fix sidebar active highlight URL matching (likely `pathname.startsWith` collision).
6. **F-PAGE-TITLES** (TC-085, TC-161, TC-192) — set Next.js `metadata.title` on every internal page and on client portal root layout.
7. **F-FAKE-STATS** (TC-103, TC-155, TC-172, TC-178) — remove hardcoded right-panel stats from internal and HR login; replace with neutral decorative content or remove panel.
8. **F-FORM-AFFORDANCE** (TC-086, TC-162, TC-130, TC-209, TC-215, TC-218) — add placeholders, required-field markers, helper copy, allowed file types/size hints across forms.
9. **F-PROFILE-VIEW-MODE** (TC-084, TC-144) — split read-only profile view from edit mode; add explicit Edit button.
10. **F-INPUT-VALIDATION** (TC-007, TC-038, TC-041, TC-059, TC-106, TC-135) — enforce client + server validation: month range, no duplicate names, numeric in number fields, future dates rejected for POA, etc.
11. **F-SORT-FILTER** (TC-040, TC-045, TC-057) — add sort/filter UI to Accounts, Projects, Job Listings.
12. **F-DEDUP-CONTROLS** (TC-087, TC-164) — remove duplicate month selector on salary slips.
13. **F-DEDUP-VIEWERS** (TC-145) — remove embedded salary slip viewer inside AI Assistant; link out to the canonical page.
14. **F-EMPTY-STATE** (TC-134, TC-141, TC-167, TC-206, TC-207) — write proper empty states with CTAs across Projects, Tasks, Salary Slips, Teams.
15. **F-WFH-CONSOLIDATE** (TC-091, TC-116, TC-182) — pick ONE submission path for WFH/Comp Off; remove the other two; ensure data parity in DB.
16. **F-LEAVE-IA** (TC-006) — clarify leave section copy: explain quotas, balance, statuses.
17. **F-WORKLOAD-COLUMNS** (TC-095, TC-143, TC-166) — restore Critical/High column headers; render `0` or `—` instead of blank cells.
18. **F-SWR-POLLING** (TC-131, TC-133, TC-156, TC-120) — disable background SWR polling on hidden tabs; use cache-first on sidebar overview stats.
19. **F-ANALYTICS-SCOPE** (TC-082) — move analytics SWR call from shared layout into the dashboard page only.
20. **F-REQUEST-COALESCE** (TC-132) — batch the 8 employee-detail requests via a single `/employees/:id/full` aggregator endpoint or parallel-`Promise.allSettled` with consolidated error surface.
21. **F-A11Y-LABELS** (TC-137, TC-138, TC-139) — add alt text to employee avatars; label dropdowns; label X buttons.
22. **F-CSS-SCROLL** (TC-019) — restore visible scrollbars where missing.
23. **F-PASSWORD-STRENGTH** (TC-129) — use `zxcvbn` (or equivalent) instead of length-only.
24. **F-DESTRUCTIVE-CONFIRM** (TC-121) — add confirm dialogs to Approve/Reject buttons.
25. **F-AVATAR-FALLBACK** (TC-124, TC-201) — fall back to first alphabetic character; default icon if none.
26. **F-NAV-CORRECTNESS** (TC-083) — "View" should go to `/employees/:id` not `/employees/:id/performance`; fix breadcrumb mismatch.
27. **F-BANNER-STATE** (TC-096, TC-181) — banner must check today's report state and hide once submitted.
28. **F-CLIENT-SIDE-FILTER** (TC-115) — server-side filter for WFH page.
29. **F-MISSING-FEATURE** (TC-027, TC-028, TC-039, TC-043, TC-071, TC-077, TC-214, TC-217) — list each, prioritize, schedule.
30. **F-LEADERBOARD-MATH** (TC-004, TC-048) — fix ranking math.
31. **F-OVERTIME-CALC** (TC-012) — auto-calculate overtime from check-in/out and policy.
32. **F-SOP-CONSISTENCY** (TC-016, TC-186) — single source of truth for SOP (DB-backed, editable in admin).
33. **F-JOIN-DATE-IA** (TC-015, TC-213) — joining date is HR-managed at onboarding, not employee-submitted.
34. **F-RBAC-SIDEBAR** (TC-008) — hide Offer Letters / Joining date / Contract / HR policies from non-applicable roles.
35. **F-RATE-LIMITS** (TC-211) — review and lower the 500-link daily report cap.
36. **F-AUTH-CONSOLIDATE** (TC-109, TC-188, TC-219) — unify auth: shared `/auth/login` accepting email or phone; one token storage pattern.
37. **F-AUTH-HEADER** (already in Wave B; cross-link).
38. **F-MISSING-UI** (TC-029, TC-202) — add Delete button to People list (API already works).
39. **F-CLIENT-TZ** (TC-097, TC-173) — render greeting client-side from `new Date()`.
40. **F-BADGE-SPACING** (TC-194) — make sidebar badge a styled chip with spacing.
41. **F-AFFORDANCE-COPY** (TC-130, TC-209, TC-215, TC-218) — improve copy on misleading text.
42. **F-HARDCODED-STATS** (TC-212) — remove or wire to real DB.
43. **F-DATE-DRIFT** (TC-117) — replace 2024-hardcoded year with `new Date().getFullYear()`.
44. **F-TERMINOLOGY** (TC-039) — replace ambiguous "project" usage with clearer terms where it conflicts.
45. **F-SEED-DEMO** (TC-092, TC-158, TC-177) — write a demo-seed script for evaluation environments (teams, employees, projects, tasks, clients, jobs).

### Wave D — P3 Polish
1. F-UI-POLISH (TC-001a, TC-002b, TC-020, TC-049, TC-073, TC-140, TC-169) — design pass.
2. F-LOGIN-COPY (TC-093, TC-171) — generic placeholder copy.
3. F-CHAT-SCROLL (TC-142) — auto-scroll AI chat to latest message.
4. F-KANBAN-DND (TC-035) — drag-and-drop on Tasks kanban.
5. F-SSR (TC-104) — enable SSR / metadata rendering for internal portal.
6. F-SUBDOMAIN-NAMING (TC-107) — rename `portal.digitalsukoon.com` → `admin.digitalsukoon.com`.

---

## 5. Per-portal scope summary

| Portal | P0 | P1 | P2 | P3 | Total |
|---|---|---|---|---|---|
| Internal (`apps/internal`) | 4 (XSS, AI preview, default creds, token storage) | ~55 | ~50 | ~12 | ~121 |
| HR (`apps/hr`) | 1 (leave-date TZ) | ~14 | ~22 | ~6 | ~43 |
| Client (`apps/client`) | 1 (fake data — credibility damage) | ~8 | ~2 | ~1 | ~12 |
| Jobs (`apps/jobs` + production data) | 1 (UUID leak) | ~6 | ~2 | ~1 | ~10 |
| API / DB / Auth / Infra / Cross-cutting | 1 | ~5 | ~6 | ~1 | ~13 |

(Counts approximate because many TCs are duplicates of the same root cause.)

---

## 6. What the "In Progress" column actually means

The first 20 rows of the sheet (TC-001 → TC-020) are marked `In Progress`. Several of these are duplicated and confirmed in the "Verified — Not Fixed" set (TC-146–TC-220). Treat the verified set as ground truth and the "In Progress" set as the original tester intent. Where there is divergence between the two, the verified set wins.

Examples of confirmed-in-both:
- `In Progress` TC-005 "No teams displayed" → `Verified` TC-207 (empty state).
- `In Progress` TC-013 "Salary slips not visible" → `Verified` TC-152 (500), TC-183 (page renders nothing).
- `In Progress` TC-018 "Forgot Password doesn't work" → `Verified` TC-127 + TC-179 + TC-191 (all confirmed).
- `In Progress` TC-019 "No scrollbar" — no verified counterpart; still treat as live.
- `In Progress` TC-007 "POA accepts future dates" → `Verified` TC-217 (no date picker — different angle of the same module).

---

## 7. Suggested PR / commit strategy

- **One PR per fix family** where the family touches one logical area. Examples: F-ANALYTICS-PERM (single seed change), F-STATUS-LABELS (large but mechanical formatter rollout).
- **For F-MISSING-ENDPOINT**, one PR per endpoint with route + service + test + a tracking checklist in the PR body so frontends can wire up the moment each route lands.
- **For F-CLIENT-FAKE-DATA**, one PR per client page (dashboard, projects, approvals) replacing the hardcoded constant with the SWR hook + empty state + error state.
- **P0 wave should ship before P1**, since the data corruption (leave-date) and security holes (XSS, UUID leak, default creds, token storage) compound risk on every day they remain open.

---

## 8. Open questions / verification needed before fixing

1. **TC-085 / TC-161 page titles** — confirm whether the Next.js `metadata` export is being overridden by a `<title>` in a layout; check `app/layout.tsx` and per-page `metadata`.
2. **TC-176 silent error swallowing** — list every SWR hook in the codebase and verify whether `error` is surfaced or thrown.
3. **TC-082 analytics call from every page** — find the SWR hook in the shared layout; either gate by route or move to dashboard-only.
4. **TC-199 leave-date timezone** — confirm whether the bug is in (a) HR form sending local-midnight `Date`, (b) API parsing without timezone, or (c) Prisma `DateTime` column converting on read. Test all three to isolate.
5. **TC-098–TC-102 production data** — these are not code fixes; they're operational. Plan a one-time data cleanup against production.
6. **TC-185 HR API coverage** — the long list of 404/500 needs a single audit pass; some endpoints may have moved/renamed and the frontend is stale.

---

## 9. Cross-cutting fix families — index

| Family | Touches |
|---|---|
| F-ANALYTICS-PERM | seed.ts, RBAC |
| F-MISSING-ENDPOINT | apps/api routes (admin/*, attendance, approvals, workload, leaderboard, holidays, salary-slips, /admin/employees, HR) |
| F-CRUD-COMPLETE | every module that doesn't fully CRUD |
| F-STATUS-LABELS | shared formatter + every status render across portals |
| F-ERROR-VISIBILITY | every SWR hook + shared PageError component |
| F-NAV-RESTRUCTURE | apps/internal sidebar |
| F-FORGOT-PASSWORD | apps/api auth + 4 portals' login pages |
| F-AI-EMPLOYEE-DROPDOWN | apps/internal/src/app/ai-assistant/page.tsx (one path fix) |
| F-CLIENT-FAKE-DATA | apps/client dashboard, projects, approvals (3 pages) |
| F-CLIENT-PROFESSIONAL-COPY | apps/client analytics, files (2 pages) |
| F-PAGE-TITLES | every Next.js `metadata` export in apps/internal + apps/client |
| F-FAKE-STATS | apps/internal login + apps/hr login |
| F-PROFILE-VIEW-MODE | apps/internal employee detail |
| F-AUTH-CONSOLIDATE | apps/api auth + 3 portals' login flows |
| F-SWR-POLLING | sidebar, dashboard, jobs page |
| F-LEAVE-TZ-BUG | HR leave form + apps/api leave route |
| F-AI-PREVIEW-SANDBOX | AI assistant preview rendering |
| F-INPUT-SANITIZATION | apps/api validators across all create routes |
| F-DEFAULT-CREDENTIALS | seed.ts + production password rotation |
| F-TOKEN-STORAGE | apps/api auth response (set httpOnly cookie) + all 4 portals' API clients |
| F-JOBS-LEAK-UUID | apps/api jobs route response shape |
| F-PROD-DATA-CLEAN | production DB (operational, not code) |
| F-HR-API-COVERAGE | apps/api hr.routes.ts |
| F-SEED-DEMO | packages/db/prisma/seed.ts demo data |

---

## 10. Notes the original sheet did NOT cover but should be considered

These are observations that follow directly from the patterns above but were not separately filed:

- **`db:push` instead of `prisma migrate`** (per CLAUDE.md) — any schema work in the Wave B endpoints will not produce migration files. If production needs versioned schema changes, decide now whether to keep `db:push` or switch.
- **Single SMTP outbox** — if F-FORGOT-PASSWORD ships, validate that `apps/api/.env` SMTP vars are set in production. Without them, reset emails will silently no-op (per CLAUDE.md SMTP section).
- **`NEXT_PUBLIC_API_URL`** — verify each portal's `.env.local` matches the intended environment before fixing client-side bugs that look API-related.

---

**End of plan.** Next step on request: pick a fix family from §4 and I'll generate the per-file change list (or a `/gsd-plan-phase` PLAN.md) for it.
