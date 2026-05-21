# Portal Test — Final v3: Consolidated Audit & Remediation Plan

**Last updated:** 2026-05-21
**Sources consolidated into this document:**

| Source | Items | Target portal | Date |
|---|---|---|---|
| `Portal Test - Final v2.xlsx` (215 TCs) | TC-001 → TC-220 | All four portals | 2026-05-16 |
| `portal_ux_issues.xlsx` (101 issues) | #1 → #101 | Internal portal (`portal.digitalsukoon.com`) | 2026-05-20 |
| `DigitalSukoon_BugReport.xlsx` (25 bugs) | BUG-01 → BUG-25 | Client portal (`client.digitalsukoon.com`) | 2026-05-20 |
| HR end-to-end page audit (this doc, §3) | 29 pages | HR portal (`hr.digitalsukoon.com`) | 2026-05-21 |

**Today's date:** 2026-05-21 (last updated: 2026-05-21 — Waves 4 partial + Wave 5 cleanup script done)
**Plan owner:** This file is the single source of truth for portal remediation across **Internal, HR, and Client**. All older `.planning/*` files (INTERNAL-PORTAL-AUDIT.md, INTERNAL-PORTAL-ERRORS.md, INTERNAL-PORTAL-V2-PLAN.md, CLIENT-PORTAL-AUDIT.md, CLIENT-PORTAL-ERRORS.md) are now superseded by §3 of this document.

---

## 1. Current state — one-glance summary

| Portal | ✅ Done | ❌ Open code bugs | 🗑 Production data cleanup | ❓ Needs runtime verify |
|---|---|---|---|---|
| **Internal** | 17 fix families + Wave 2 + Wave 3 + mobile sidebar drawer shipped | **36** | **43** | 1 |
| **HR** | All 29 pages + Wave 3 polish + mobile sidebar drawer shipped | **6** | 0 | 1 (login fake panel) |
| **Client** | 9 of 25 QA bugs fixed; mobile drawer already had `lg:hidden` pattern | **11** | 0 | 4 |
| **Cross-cutting / API** | Wave A P0 items closed; HR+Internal mobile sidebars done 2026-05-21; **4.2 F-NAV-RESTRUCTURE shipped 2026-05-21** (Analytics/Workload/Expenses/Devices/Complaints/Bug Reports/AI Assistant now in named sidebar sections); **4.3 F-NAV-LABELS already done** (HR sidebar already had full names); **4.5 F-CLIENT-PERF shipped 2026-05-21** (removed analytics 60s poll, added dedupingInterval+revalidateOnFocus:false to all heavy client hooks); **F-TOKEN-STORAGE and F-RESPONSIVE-ALL-PORTALS deferred** (XL, disproportionate risk/effort) | 0 architectural items remain | — | — |

**Verdict:** None of the three portals is "free of issues whatsoever" yet. The HR portal is closest — all 27 pages render and call working endpoints — but it still has PII masking, password policy, and status-label items open. Internal portal has the most open items (36 code + 43 data) but most are P2/P3 polish. Client portal has 11 open bugs; the mobile sidebar was already implemented — remaining critical is BUG-24 (session-on-resize) and BUG-22 (page freeze). Wave 5 cleanup script is written (`scripts/cleanup-production.ts`) and ready for dry-run review on production.

---

## 2. What is already fixed (don't re-do)

### 2.1 Internal portal — fix families fully shipped (2026-05-19 onward)
| Family | TCs / Issues closed | Evidence |
|---|---|---|
| F-AI-EMPLOYEE-DROPDOWN | TC-061/063/065/081/154/163 | `apps/internal/src/app/ai-assistant/page.tsx` calls `/employees` |
| F-ANALYTICS-PERM | TC-080/153/165 | `packages/db/prisma/seed.ts` grants `analytics` to Admin |
| F-DATE-DRIFT | TC-117 | No hardcoded 2024 in salary slip utils |
| F-STATUS-LABELS (internal) | TC-118/136/203/204/205/220 | `formatStatus()` applied across 10+ internal pages |
| F-AI-PREVIEW-SANDBOX | TC-112/113 | DOMPurify + `sandbox="allow-same-origin"` in AI assistant |
| F-INPUT-SANITIZATION | TC-200 | `safeString` in validators across `packages/shared/src/validators/` |
| F-FAKE-STATS (internal login) | TC-155/172 | Internal login has no hardcoded stat panel (HR login NOT yet verified — see §3.2) |
| F-LOGIN-COPY | TC-093/171 | Internal login placeholder generic |
| F-MISSING-ENDPOINT | TC-146/147/148/149/150/151/152 | Attendance, approvals, workload, admin/clients, leaderboard, holidays, salary-slips all present |
| F-FORGOT-PASSWORD (internal) | TC-018 | `/auth/forgot-password` route + login link wired |
| F-LOGIN-LAYOUT-RACE | — | `apps/internal/src/app/layout.tsx` checks localStorage for token before redirecting |
| F-XSS (content detail) | — | `content/[id]/page.tsx` — innerHTML replaced with safe DOM API |
| F-MISSING-PAGES | — | `/settings` and `/clients/[id]` exist |
| F-SERVICE-MISMATCHES | TC-151/152 | 5 admin-features route→service mismatches fixed; `getContractById` added |
| F-UI-POLL-TEXT | TC-169 | Hardcoded "Auto-refreshes every 30s" removed from jobs page |
| F-JOBS-LEAK-UUID | TC-105 | `getActiveJobListings()` + `getPublicJobListingById()` use `select` |
| F-DASHBOARD-OVERHAUL | 2026-05-19 | 11 stat cards, Quick Assign modal, Links Activity chart, /reports/links page |
| F-NAV-RESTRUCTURE | 4.2 ✅ 2026-05-21 | Internal sidebar: Analytics/Workload/Expenses/Devices/Complaints/Bug Reports/AI Assistant out of "More" into named sections ("Analytics", "Tools"). More now contains only: Salary Slips, Offer Letters, Holiday Calendar, Job Listings, Auto Teams, Internships, Settings. |
| F-CLIENT-PERF | 4.5 ✅ 2026-05-21 | Removed 60s `refreshInterval` from analytics hook. Added `revalidateOnFocus: false` + `dedupingInterval` (300s analytics, 120s projects, 60s content/files) to all heavy SWR hooks. |

### 2.2 HR portal — fix families fully shipped
| Family | Status | Evidence |
|---|---|---|
| F-HR-API-COVERAGE | ✅ | All 27 pages call existing endpoints in `apps/api/src/routes/hr-features.routes.ts` |
| F-FORGOT-PASSWORD (hr) | ✅ | HR login → `POST /auth/forgot-password` with `{ app: "hr" }` |
| F-RESET-REDIRECT (hr) | ✅ | `HrAuthProvider` whitelists `/reset-password` |
| F-LEAVE-TZ-BUG (TC-199) | ✅ MITIGATED | Form sends ISO `YYYY-MM-DD`; `leave.service.ts:17-20` parses with `setHours(0,0,0,0)` correctly |
| F-WORK-CALENDAR | TC-187/216 | `/hr/calendar` endpoint implemented and returns calendar data |
| F-BANNER-STATE | TC-096/181 | Daily report banner hides when `submitted === true` |
| F-DAILY-REPORT-LIMITS | TC-211 | `MAX_LINKS=500` and `MAX_LINKS_PER_ACCOUNT=100` enforced on form |
| F-HR-REDESIGN | 2026-05-20 | Collapsible rail sidebar, v3-card system, Fraunces/Plus Jakarta Sans, all 27 pages reskinned |

### 2.3 Client portal — fix families fully shipped
| Family | Status | Evidence |
|---|---|---|
| F-CLIENT-FAKE-DATA | ✅ | dashboard / projects / approvals all use SWR hooks |
| F-CLIENT-PROFESSIONAL-COPY | ✅ | No internal sprint copy on analytics/files |
| F-PAGE-TITLES (client) | ✅ | `<title>` set in `apps/client/src/app/layout.tsx` |
| F-FORGOT-PASSWORD (client) | ✅ | Modal + `/reset-password` page + endpoints wired |
| F-RESET-REDIRECT (client) | ✅ | `/reset-password` whitelisted in client layout |
| F-FILE-UPLOAD | ✅ | `POST/DELETE /v1/client/files` + drag-drop wired |
| BUG-01 (tab labels) | ✅ FIXED (recent redesign) | `apps/client/src/app/login/page.tsx:204-223` segmented control |
| BUG-07 (no failed-login error) | ✅ FIXED | `apps/client/src/app/login/page.tsx:51-67,271-276` `setError` + AlertCircle |
| BUG-08 (Sign in nav button) | ✅ FIXED | `apps/client/src/app/login/page.tsx:114-120` scroll handler |
| BUG-09 (Hero CTA) | ✅ FIXED | `apps/client/src/app/login/page.tsx:158-164` scroll handler |
| BUG-11 (Format=null) | ✅ FIXED | `apps/client/src/app/content/[id]/page.tsx:159` safe ternary on `format` |
| BUG-25 (Brief validation) | ✅ FIXED | `new-brief-modal.tsx:36-37` disables submit until len ≥ 2 |

---

## 3. What is still open (the actionable backlog)

This is the master list of bugs that need code fixes. It is grouped by portal and ordered by severity. Each row cites file:line evidence and references the original issue ID (TC-, #, BUG-) for traceability.

### 3.1 Internal portal — 37 open code bugs + 43 production-data-cleanup items

#### 3.1.1 P0 / High-severity code bugs (6)
| ID | Issue | File:line | Fix family |
|---|---|---|---|
| #22, #66, TC-22 | Admin can approve own leave | `apps/api/src/services/leave.service.ts:78` (`approveLeaveRequest()` no self-check) + `apps/api/src/routes/admin-features.routes.ts:444` calls without guard | F-SELF-APPROVAL-GUARD |
| #9, #71 | Dashboard "78 Active Employees" vs Employees list "50 total" | `apps/internal/src/app/dashboard/page.tsx:21` uses `totalUsersCount` (all users incl. admins) instead of filtered employee count from `analytics.service.ts` `employeeWhere` | F-DASHBOARD-COUNT |
| #36 | UTM tracking params exposed in account names ("viral_paps?igsh=…", "archivebollywood?utm_source=…") | Account create/import flow + display. Strip query string in `apps/api/src/services/account.service.ts` create/update + bulk-import. | F-ACCOUNT-NAME-SANITIZE |
| #48 | No confirmation dialog before deleting a job posting | `apps/internal/src/app/jobs/page.tsx` delete handler | F-DESTRUCTIVE-CONFIRM |
| #59 | Add Employee password field auto-fills with admin creds | Add-employee form input missing `autocomplete="new-password"` attribute | F-AUTOCOMPLETE-NEW-PASSWORD |
| #26 | "Keep me signed in" pre-checked by default | `apps/internal/src/app/login/page.tsx:198` `defaultChecked` removed | F-KEEP-SIGNED-DEFAULT |
| #37 | Delete actions have no confirm on Clients / Holidays | Clients and Holidays delete buttons | F-DESTRUCTIVE-CONFIRM (dup) |

#### 3.1.2 P1 / Medium-severity code bugs (~22)
| ID | Issue | File:line | Fix family |
|---|---|---|---|
| #1, #25 | Mac ⌘K shown on Windows | `apps/internal/src/components/top-nav.tsx:119` hardcoded "⌘K" — needs `navigator.platform` detection | F-PLATFORM-SHORTCUT |
| #12, #77 | "1 members" grammar on Teams | `apps/internal/src/app/teams/page.tsx:149` `{count} members` no plural check | F-PLURALIZATION |
| #19, #87 | "1 projects" grammar on Clients | `apps/internal/src/app/clients/page.tsx:81` same pattern | F-PLURALIZATION (dup) |
| #2 | Landing-page nav links open same tab | Landing component anchors — add `target="_blank" rel="noopener"` | F-NAV-NEWTAB |
| #3 | Footer Status/Changelog/Security `href="#"` | Landing footer | F-FOOTER-LINKS |
| #5 | Empty email shows only "Password is required" | Login form validator — validate both fields | F-LOGIN-VALIDATION |
| #7 | Forgot-password modal: no close/confirm button after success state | Login forgot modal | F-FORGOT-MODAL-CTA |
| #6 | Forgot-password modal uses browser-native vs custom errors | Same modal | F-FORGOT-MODAL-VALIDATION |
| #8 | Dashboard announcement banner has no content (only megaphone) | Dashboard announcement card — show last announcement or "No announcements yet" | F-ANNOUNCEMENT-EMPTY |
| #10 | Inconsistent employee name casing on Employees list | Apply Title-Case formatter at render layer; also normalize on save | F-NAME-CASE |
| #11 | "PERF." column header unclear | Employees list table header | F-PERF-COLUMN-LABEL |
| #16 | Generic globe icon for all platforms on Accounts | Platform icon map needed on accounts list/detail | F-PLATFORM-ICONS |
| #24 | Analytics shows 78 employees but Present/Late/Absent all 0 | Analytics service attendance query may not be returning records — possibly attendance not being recorded at all, or query filters by wrong date | F-ATTENDANCE-ANALYTICS |
| #28 | 11 stat cards overflow on screens < 1400px | Dashboard grid CSS — wrap to multiple rows | F-DASHBOARD-RESPONSIVE |
| #30 | TEAM column empty for nearly all employees | Verify whether employees actually have team assignments in DB or display query is dropping the join | F-EMPLOYEE-TEAM-COLUMN |
| #31 | Attendance date "5/11/2026" US format | Attendance list date column — use `formatDate` util | F-DATE-FORMAT-ATTENDANCE |
| #32 | Zero-value attendance bars render full width | Analytics bar component — zero value should render zero-width | F-ZERO-BAR |
| #33, #91 | Reports "Today" stat shows raw ISO "2026-05-20" | `apps/internal/src/app/reports/page.tsx:60` — wrap in `formatDate` | F-REPORTS-DATE-FORMAT |
| #34 | Native browser date inputs ("dd-mm-yyyy") in Reports filter | Replace `<input type="date">` with `@dashmani/ui` styled date picker | F-DATE-PICKER-STYLE |
| #35 | Workload Matrix slow load (~4s) with bare spinner | Add skeleton loader; investigate query perf | F-WORKLOAD-LOADING |
| #45 | Test announcement only ("Test Announcement / Hello World") in production | Mostly data-cleanup; also build empty-state | F-ANNOUNCEMENT-EMPTY (dup) |
| #47 | Job department field has job title as value | Add Zod validation + dropdown of valid departments | F-JOB-DEPARTMENT-VALIDATE |
| #49 | Admin user applied/accepted into own company's internship | Block internal users from applying — flag by email domain match | F-INTERNSHIP-SELF-APPLY |
| #51 | Internship applicant email stored in ALL CAPS | Apply `normalizedEmail` from `packages/shared/src/utils/sanitize.ts` to internship form (currently missing) | F-INTERNSHIP-EMAIL-NORMALIZE |
| #56 | Notification bell navigates to /announcements instead of opening dropdown panel | Top-nav bell click handler — implement notifications popover; `/hr/notifications` endpoints already exist | F-NOTIFICATION-DROPDOWN |
| #58 | Role chips in Edit Employee don't show selected state | `apps/internal/src/app/employees/[id]/page.tsx` role chip render — apply selected-state styling | F-ROLE-CHIP-STATE |
| #60 | Add Employee form missing Designation/Department/Join Date/Salary/Team fields | Add-employee form needs additional inputs + Zod schema updates | F-ADD-EMPLOYEE-FIELDS |
| #62 | Task detail "Due:" cut to "D" | Task detail page CSS — `overflow:hidden` on label container | F-TASK-DUE-OVERFLOW |
| #63 | New Task form no validation error on empty Title | Form validator — show inline error | F-TASK-TITLE-VALIDATION |
| #64 | "History" button label misleading — links to /announcements | Top-nav: rename to "Announcements" with megaphone icon | F-HISTORY-BUTTON-LABEL |
| #67 | AI Chat silently ignored if employee not selected | AI assistant chat submit — show "Please select an employee" inline error | F-AI-CHAT-EMPLOYEE-VALIDATE |
| #69 | Super Admin cannot edit own name/email on Settings | `apps/internal/src/app/settings/page.tsx` — remove read-only restriction for Super Admin | F-SETTINGS-EDITABLE |
| #41 | Inconsistent device name casing | Apply normalization on Device create/save + Title-Case at render | F-DEVICE-NAME-CASE |
| #99 | Personal Gmail addresses exposed in Devices table | Show only work email or employee ID in Devices table | F-DEVICES-PII |
| #43, #82 | Account follower counts show 0 | Follower-sync service likely broken — check `apps/api/src/services/follower-sync.service.ts` cron and last-sync timestamps | F-FOLLOWER-SYNC |
| #53 | Auto Teams: members tagged with wrong team name | Audit auto-detection algorithm | F-AUTO-TEAM-TAG |
| #54 | Duplicate employees with slight name/email variation ("Ayush Gupta" vs "Ayush gupta") | Add duplicate-detection on user create (Levenshtein on name + email-localpart comparison) | F-DUP-EMPLOYEE-DETECT |
| #57 | Duplicate admin accounts for same person (3 sudhanshu entries) | Data cleanup + add dup check on admin invite | F-DUP-ADMIN-DETECT (overlaps with #54) |

#### 3.1.3 P2 / Low-severity code bugs (~9)
| ID | Issue | File:line | Fix family |
|---|---|---|---|
| #4 | ~200px extra whitespace below footer on landing page | Landing CSS | F-FOOTER-WHITESPACE |
| #17, #81 | "bollywood mirrorr" typo — also no validation on duplicate/typo account names | Add input validation; data-cleanup the existing typo | F-ACCOUNT-NAME-VALIDATE |
| #18 | "In:/Fa:/Yt:" abbreviations on Workload with no legend | Tooltip on hover or legend chip | F-WORKLOAD-LEGEND |
| #23, #29, #74 | Sidebar "More" grid labels wrap mid-word ("Internship" + "s") | `apps/internal/src/components/sidebar.tsx:42,249` — widen grid columns or shorten labels; CSS `hyphens: manual` | F-SIDEBAR-WRAP |
| #38, #68, #79, #83, #90, #93, #96, #100, #101 | Breadcrumb capitalisation inconsistent vs page heading across 9 pages: "Salary slips", "Offer letters", "Bug reports", "Ai assistant", "Teams" (vs "Team Structure"), "Workload" (vs "Workload Matrix"), "Holidays" (vs "Holiday Calendar"), "Devices" (vs "Assigned Devices"), "Complaints" (vs "Employee Complaints") | Sweep breadcrumb labels — single PR across all sidebar/breadcrumb sources | F-BREADCRUMB-CASE |
| #39, #95 | Add Holiday form always expanded | Holidays page — move form into modal | F-HOLIDAY-FORM-MODAL |
| #40 | Expenses empty-state uses `$` icon instead of `₹` | Empty-state icon swap | F-CURRENCY-ICON |
| #55 | "Auto teams" breadcrumb vs "Auto-Detected Teams" heading | Same as F-BREADCRUMB-CASE | F-BREADCRUMB-CASE (dup) |
| #61, #75 | Page titles missing on Tasks, Task Detail, Expenses, Attendance, AI Assistant ("Dashmani Portal" generic) | Add `usePageTitle(...)` to each | F-PAGE-TITLES-INTERNAL-2 |
| #70 | Change Password missing show/hide toggle | Settings page password fields | F-PWD-SHOW-HIDE |
| #92 | Leaderboard button yellow (inconsistent with other CTAs) | Reports page button styling | F-LEADERBOARD-BTN-STYLE |
| #27 | Login preview dashboard stats all 0 | `apps/internal/src/app/login/page.tsx:405-408` — either wire to real stats (cached) or use neutral copy | F-LOGIN-PREVIEW-STATS |

#### 3.1.4 Production data cleanup (43 items — NOT code bugs)

These require deleting / editing rows in the production DB. Will not be re-listed individually but they include: test announcements ("Test Announcement / Hello World"), test tasks ("test", "demo tabish", "sdfdg"), test content posts ("just testing", "QA Test Brief", "Demo Content Tabish"), test clients ("Demo Client Co. Tabish", "Demo Client Co."), test holidays ("demo"/"demo"), test job postings ("Demo Job", "Social Media Manager" misconfigured), test complaints ("dsfds"/"dsfdsf"), test bug reports ("demo"), test team names ("Facebook" empty, "total filmi" lowercase, 5 duplicate "TellyDrama Team"), duplicate admin accounts (3 sudhanshu), lowercase employee names ("aniket verma", "mac verma"), inconsistent device casing, test internship applications ("sdsf"/"fdgfd", `SUDANSHU@DIGITALSUKOON.COM`, 2× test@test.com), admin applied/accepted into own internship, "bollywood mirrorr" double-r account.

**Action:** Cleanup script + admin-UI walk-through. See §5.4.

---

### 3.2 HR portal — 7 open code bugs

| TC / ID | Issue | File:line | Severity | Fix family |
|---|---|---|---|---|
| TC-208 | Aadhaar / PAN / Bank A/c / IFSC plain text — no masking after save | `apps/hr/src/app/profile/page.tsx:181,185,141` | P1 | F-PII-MASKING |
| TC-209/210 | Status renders `ACTIVE`/`ONBOARDING` uppercase; Designation literal "Assigned by Admin" | `apps/hr/src/app/profile/page.tsx:114,121` | P2 | F-STATUS-LABELS (HR) |
| TC-091/116/182 | Three submission paths for WFH/Comp-Off: Leave dropdown + `/wfh` + `/comp-off` | `apps/hr/src/app/leave/page.tsx:102` dropdown includes WFH, plus `/wfh` and `/comp-off` pages exist | P2 | F-WFH-CONSOLIDATE |
| TC-115 | WFH page filters all leave requests client-side | `apps/hr/src/app/wfh/page.tsx:18` filters `r.type === "WFH"` after fetching all leave | P2 | F-WFH-SERVER-FILTER |
| TC-186 | SOP content hardcoded in component, not DB-backed | `apps/hr/src/app/sop/page.tsx:45-100` static `sections` array | P2 | F-SOP-DB-BACKED |
| TC-212 | Company stats "50+ Team Members" / "200+ Clients Served" hardcoded | `apps/hr/src/app/company/page.tsx:46-48` | P2 | F-HARDCODED-STATS |
| TC-218 | Presentations: "Marp markdown" jargon, no live preview pane | `apps/hr/src/app/presentations/page.tsx:388-421` — only export-to-HTML preview | P3 | F-PRESENTATIONS-LIVE-PREVIEW |
| TC-129 | Change-password policy length-only (≥6) on profile | `apps/hr/src/app/profile/page.tsx:245` — should add uppercase/digit/special-char rules | P2 | F-PASSWORD-STRENGTH |
| TC-103/178 | HR login right panel: fake widgets / hardcoded stats (NOT VERIFIED yet) | `apps/hr/src/app/login/page.tsx` — needs runtime verify | NEEDS-VERIFY | F-FAKE-STATS (HR) |

---

### 3.3 Client portal — 12 open code bugs + 4 needs-verify

| BUG ID | Issue | File:line | Severity | Fix family |
|---|---|---|---|---|
| ~~BUG-23~~ | ~~No mobile layout — app unusable below 640px~~ | **FIXED 2026-05-21** — HR: `hr-sidebar.tsx` + `portal-shell.tsx` rewritten with `hidden lg:flex` desktop rail + fixed mobile top-bar + hamburger overlay drawer. Internal: `sidebar.tsx` + `layout.tsx` same pattern. Client already had this. | ~~Critical~~ | F-CLIENT-MOBILE ✅ |
| BUG-24 | Window resize invalidates session — user redirected to /login | `apps/client/src/app/layout.tsx:17-26` — useEffect deps may re-run; needs runtime verify but layout guard is suspect | Critical | F-CLIENT-RESIZE-LOGOUT |
| BUG-22 | Page frequently freezes requiring reload | App-wide perf; profile via DevTools needed | High | F-CLIENT-PERF |
| BUG-04 | Footer Terms / Privacy / Status all `href="#"` | `apps/client/src/app/login/page.tsx:425-427` | High | F-CLIENT-FOOTER-LINKS |
| BUG-06 | "How It Works" stats labels visible but number fields blank | `apps/client/src/app/login/page.tsx:378-388` — appears static hardcoded; if intentional design, ignore; if data, fix | High | F-CLIENT-HOWITWORKS-STATS |
| BUG-13 | Story preview shows fully black rectangle | `apps/client/src/components/ig-previews.tsx:101-118` uses `ig-hatch-dark` class — verify story media renders | High | F-CLIENT-STORY-PREVIEW |
| BUG-02, BUG-03 | "Our work" and "The studio" both link to `https://digitalsukoon.com`, same tab | `apps/client/src/app/login/page.tsx:109,111` — distinct URLs + `target="_blank"` | Medium | F-CLIENT-NAV-LINKS |
| BUG-05 | Hero stats widget animates random numbers | `apps/client/src/app/login/page.tsx:537-540` `useCounter` — confirm intended behavior | Medium | F-CLIENT-HERO-COUNTER |
| BUG-12 | Content detail "Created by" field blank | `apps/client/src/app/content/[id]/page.tsx:161` — `post.authorName` no fallback | Medium | F-CLIENT-AUTHOR-FALLBACK |
| BUG-16 | Global search doesn't return content posts | `apps/client/src/components/command-palette.tsx:78-90` — only searches pages + projects | Medium | F-CLIENT-SEARCH-POSTS |
| BUG-19 | Format mix chart shows "No data yet" (cascading from null formats — but BUG-11 is fixed) | `apps/client/src/app/analytics/page.tsx:143,203-204` — verify after BUG-11 fix shipped | Medium | F-CLIENT-FORMAT-MIX |
| BUG-20 | Publishing cadence chart ~20 posts vs Total posts card shows 3 | `apps/client/src/app/analytics/page.tsx:136-150` — hardcoded `WEEKLY_DATA`; replace with API data | Medium | F-CLIENT-CADENCE-DATA |
| BUG-15 | Revision/Rejected tab missing count badge | `apps/client/src/app/content/page.tsx:65` — missing `count` prop | Low | F-CLIENT-TAB-COUNT |
| BUG-17 | "SIZEUPLOADED" concatenated column header | `apps/client/src/app/files/page.tsx:253` — grid `80px 80px` collapses gap | Low | F-CLIENT-FILES-HEADER-GAP |
| BUG-10 | Content breadcrumb "demo tabish. null" | Needs runtime verify; static read shows safe | NEEDS-VERIFY | — |
| BUG-14 | Feed preview shows hatched placeholder, no image | `apps/client/src/components/ig-previews.tsx:25` — by design or no image source? | NEEDS-VERIFY | — |
| BUG-18 | Calendar highlights wrong day (May 21 vs May 20) | `apps/client/src/components/content-calendar.tsx:67-69,104` — `new Date()` may be reading wrong tz | NEEDS-VERIFY | — |
| BUG-21 | Project Tasks card clipped beyond viewport | Project detail page CSS overflow | NEEDS-VERIFY | — |

---

### 3.4 Cross-cutting / architectural items still open

| TC | Issue | Scope | Severity | Fix family |
|---|---|---|---|---|
| TC-089/170 | Internal sidebar "More" hides Analytics, Workload, Expenses, Devices, Complaints, Bug Reports, AI Assistant | `apps/internal/src/components/sidebar.tsx` | P2 | ~~F-NAV-RESTRUCTURE~~ ✅ shipped 2026-05-21 |
| TC-090/180 | HR sidebar uses "Board"/"POA" instead of "Leaderboard"/"Plan of Action" | HR sidebar component | P3 | ~~F-NAV-LABELS~~ ✅ already done |
| TC-194 | Client sidebar Approvals badge spacing renders "Approvals 7" | `apps/client/src/components/portal-rail.tsx` badge chip | P3 | F-BADGE-SPACING |
| TC-095/143/166 | Internal Workload Critical/High columns blank when value is 0 | Workload table cells | P2 | F-WORKLOAD-COLUMNS |
| TC-007/217 | HR POA: accepts future dates; no date picker | POA page + Zod validator | P2 | F-POA-DATE |

---

## 4. Remediation plan (what to fix and in what order)

> **Constraint from the user:** "DO NOT FIX ANYTHING, PLAN A FIX." Everything below is the planned fix, not implementation. Each fix family is sized (S/M/L) and tied to its open issue IDs from §3.

### Wave 1 — P0 security & data correctness (do FIRST, separate PR per item)

| # | Fix family | Items | Size | What to change | Where |
|---|---|---|---|---|---|
| 1 | F-SELF-APPROVAL-GUARD | #22, #66 | S | In `approveLeaveRequest()`, throw 403 if `request.userId === approver.id`. Same for `rejectLeaveRequest()`. Also disable Approve/Reject buttons in UI when `request.userId === currentUser.id`. | `apps/api/src/services/leave.service.ts` + `apps/internal/src/app/approvals/page.tsx` |
| 2 | F-DASHBOARD-COUNT | #9, #71 | S | Replace `totalUsersCount` with employee-filtered count (use `employeeWhere` filter from `analytics.service.ts`). Verify Analytics > Attendance Today uses the same count. | `apps/internal/src/app/dashboard/page.tsx`, `apps/api/src/services/analytics.service.ts` |
| 3 | F-ACCOUNT-NAME-SANITIZE | #36 | S | Strip query string (`?...`) from account username before saving. Add Zod refine to reject names containing `?`, `&`, or `=`. Apply to create + bulk-import. Backfill production. | `apps/api/src/services/account.service.ts`, `bulk-import.service.ts`, `packages/shared/src/validators/account.ts` |
| 4 | F-AUTOCOMPLETE-NEW-PASSWORD | #59 | S | Add `autoComplete="new-password"` to password input on Add Employee. Also audit all admin-managed password inputs. | `apps/internal/src/app/employees/new/page.tsx` and similar |
| 5 | F-KEEP-SIGNED-DEFAULT | #26 | S | Remove `defaultChecked` on the checkbox; set initial state to `false`. | `apps/internal/src/app/login/page.tsx:198` |
| 6 | F-DESTRUCTIVE-CONFIRM | #37, #48 | S | Add `<ConfirmDialog>` (already in `@dashmani/ui`) to Clients delete, Holidays delete, Jobs delete. | apps/internal/src/app/clients, holidays, jobs |
| 7 | F-PII-MASKING (HR) | TC-208 | M | After save, render Aadhaar/PAN/Bank/IFSC as masked text (e.g. `••••••1234`) with an explicit "Edit" affordance that reveals the editable input. Show full value only during edit + immediately after save (no further reveal). | `apps/hr/src/app/profile/page.tsx` |
| 8 | F-CLIENT-RESIZE-LOGOUT | BUG-24 | M | Audit `apps/client/src/app/layout.tsx:17-26` `useEffect`. Likely the auth guard runs on a render that doesn't have token state yet — confirm with runtime test, then either (a) check localStorage synchronously before any redirect, (b) gate the redirect on `loading === false`. | `apps/client/src/app/layout.tsx` |
| 9 | F-CLIENT-MOBILE | BUG-23 | L | Add Tailwind responsive breakpoints to `portal-rail.tsx` (hide rail below `lg`, show hamburger). Wrap content in responsive container. Test login/dashboard/content at 375px. | `apps/client/src/components/portal-rail.tsx`, `apps/client/src/app/layout.tsx`, all client pages with fixed widths |

### Wave 2 — P1 broken / misleading UX (high-impact fixes)

| # | Fix family | Items | Size | What to change |
|---|---|---|---|---|
| 10 | F-PLATFORM-SHORTCUT | #1, #25 | S | Detect platform via `navigator.platform` (or `userAgent`). Show `Ctrl K` on Windows/Linux, `⌘K` on Mac. Apply to top-nav search and login hero. |
| 11 | F-PLURALIZATION | #12, #19, #77, #87 | S | Tiny `pluralize(count, singular, plural?)` util in `packages/shared/src/utils/`. Apply to all `{n} members` / `{n} projects` / `{n} tasks` etc. across portals. |
| 12 | F-BREADCRUMB-CASE | #38, #68, #79, #83, #90, #93, #96, #100, #101 | M | Sweep across all sidebar/breadcrumb sources. Define canonical names: "Salary Slips", "Offer Letters", "Bug Reports", "AI Assistant", "Team Structure", "Workload Matrix", "Holiday Calendar", "Assigned Devices", "Employee Complaints", "Daily Reports", "Auto-Detected Teams". Either rename breadcrumbs to match headings OR rename headings to match breadcrumbs — be consistent within one PR. |
| 13 | F-PAGE-TITLES-INTERNAL-2 | #61, #75 | S | Add `usePageTitle()` to Tasks, Task Detail, Expenses, Attendance, AI Assistant. |
| 14 | F-REPORTS-DATE-FORMAT | #33, #91 | S | `apps/internal/src/app/reports/page.tsx:60` — wrap raw ISO date in `formatDate` util ("20 May 2026"). |
| 15 | F-DATE-FORMAT-ATTENDANCE | #31 | S | Same `formatDate` applied to Attendance list date column. |
| 16 | F-DATE-PICKER-STYLE | #34 | M | Replace `<input type="date">` with styled date-range picker from `@dashmani/ui` or wrap with custom styling. Apply on Reports filter first; reuse on other pages. |
| 17 | F-LOGIN-VALIDATION | #5 | S | Internal login: validate both email and password fields independently; show inline error for each. |
| 18 | F-FORGOT-MODAL-CTA | #7, #6 | S | Forgot-password success state: add "Back to sign in" button. Replace browser-native validation with the same inline-error pattern as the main form. |
| 19 | F-LEADERBOARD-BTN-STYLE | #92 | S | Reports page Leaderboard button → use shared black CTA style. |
| 20 | F-SETTINGS-EDITABLE | #69 | S | Settings page: remove read-only on name/email for Super Admin (or all users — check policy). |
| 21 | F-PWD-SHOW-HIDE | #70 | S | Settings change-password: add eye-icon toggle on each of 3 fields. |
| 22 | F-TASK-TITLE-VALIDATION | #63 | S | New Task form: show "Title is required" red text + red border on submit if empty. |
| 23 | F-TASK-DUE-OVERFLOW | #62 | S | Task detail "Due:" label: fix CSS overflow so label is fully visible. |
| 24 | F-AI-CHAT-EMPLOYEE-VALIDATE | #67 | S | AI Chat submit: if `selectedEmployee` is empty, show inline error "Please select an employee". |
| 25 | F-NOTIFICATION-DROPDOWN | #56 | M | Top-nav bell click: open a Radix popover with last 20 notifications (use existing `/notifications` endpoints). Remove `<a href="/announcements">`. |
| 26 | F-HISTORY-BUTTON-LABEL | #64 | S | Rename top-nav "History" → "Announcements" with megaphone icon. |
| 27 | F-ROLE-CHIP-STATE | #58 | S | Edit Employee role chips: apply selected/highlighted style when role is assigned. |
| 28 | F-ADD-EMPLOYEE-FIELDS | #60 | M | Add Designation, Department, Join Date, Salary, Team fields to Add Employee form + Zod validator + backend mapping. |
| 29 | F-ANNOUNCEMENT-EMPTY | #8, #45 | S | Dashboard announcement card: show last announcement title/excerpt, or "No announcements yet" empty state. |
| 30 | F-EMPLOYEE-TEAM-COLUMN | #30 | S | Verify whether employees have teams in DB. If yes, fix the query. If no, surface an empty-state "No team assigned". |
| 31 | F-ATTENDANCE-ANALYTICS | #24 | M | Investigate why Analytics > Attendance Today shows 0 Present/Late/Absent. Likely date filter / timezone issue (Asia/Kolkata vs UTC midnight) — apply same fix pattern as `feedback_utc_date_timezone.md`. |
| 32 | F-DASHBOARD-RESPONSIVE | #28 | S | Dashboard 11 stat cards: switch to responsive grid (e.g. `grid-cols-2 md:grid-cols-4 xl:grid-cols-6`). |
| 33 | F-FOLLOWER-SYNC | #43, #82 | M | Investigate `follower-sync.service.ts` cron. Check last-sync timestamps. Add an admin button to "Sync now" and surface last-sync time per account on Accounts page. |
| 34 | F-CLIENT-FOOTER-LINKS | BUG-04 | S | Client login footer: route Terms/Privacy to real pages or `digitalsukoon.com/{terms,privacy}`. Remove Status link if no status page. |
| 35 | F-CLIENT-NAV-LINKS | BUG-02, BUG-03 | S | Distinct URLs for Our Work vs The Studio; add `target="_blank" rel="noopener"`. |
| 36 | F-CLIENT-AUTHOR-FALLBACK | BUG-12 | S | Content detail "Created by": fallback to `authorEmail` or `—`. |
| 37 | F-CLIENT-SEARCH-POSTS | BUG-16 | M | Extend `command-palette.tsx` to fetch + search content posts (title + first 50 chars of caption). |
| 38 | F-CLIENT-CADENCE-DATA | BUG-20 | M | Replace hardcoded `WEEKLY_DATA` with real `/analytics` data; ensure totals match Total posts card. |
| 39 | F-CLIENT-STORY-PREVIEW | BUG-13 | M | Investigate `ig-hatch-dark` class — render actual story media. |
| 40 | F-CLIENT-FILES-HEADER-GAP | BUG-17 | S | Add gap between Size and Uploaded columns in files list grid. |
| 41 | F-CLIENT-TAB-COUNT | BUG-15 | S | Revision/Rejected tab needs `count` prop (`apps/client/src/app/content/page.tsx:65`). |
| 42 | F-WFH-CONSOLIDATE | TC-091/116/182 | M | Decision: keep `/leave` form with full type dropdown OR keep dedicated `/wfh` + `/comp-off` — not both. Recommend removing the dedicated pages and using `/leave` with `?type=WFH` deep links. |
| 43 | F-WFH-SERVER-FILTER | TC-115 | S | Pass `?type=WFH` to GET `/hr/leave-requests`, server-filters. |
| 44 | F-HARDCODED-STATS | TC-212 | S | HR company page: read counts from `/hr/team` and `/admin/clients` (or simply remove the stats block). |
| 45 | F-SOP-DB-BACKED | TC-186 | M | Add `SOP` Prisma model; admin UI to edit; HR page fetches from `/hr/sop-content`. Prisma `db:push` required. |
| 46 | F-PASSWORD-STRENGTH | TC-129 | S | Add `zxcvbn` (or simple regex: 8+ chars, 1 upper, 1 digit, 1 special) to profile change-password validator + HR signup. |
| 47 | F-STATUS-LABELS (HR) | TC-209/210 | S | Wrap `profile.status` and `profile.designation` with `formatStatus()` from `@dashmani/shared`. |
| 48 | F-WORKLOAD-COLUMNS | TC-095/143/166 | S | Workload Matrix Critical/High cells: render `0` or `—` instead of blank. Restore column headers. |
| 49 | F-POA-DATE | TC-007/217 | S | HR POA form: Zod refine rejecting future dates; add date picker. |

### Wave 3 — P2 polish & data quality (do in one sweep)

| # | Fix family | Items | Size | What to change |
|---|---|---|---|---|
| 50 | F-NAME-CASE | #10, #84 | S | At render time, apply `Title Case` formatter to all employee/team/account names across portals. Also normalize on save (`safeString` already trims; add `toTitleCase()` for name fields). |
| 51 | F-DEVICE-NAME-CASE | #41 | S | Same as F-NAME-CASE applied to Device names. |
| 52 | F-INTERNSHIP-EMAIL-NORMALIZE | #51 | S | Apply `normalizedEmail` Zod schema to internship application form. Backfill: `lowercase()` existing rows. |
| 53 | F-INTERNSHIP-SELF-APPLY | #49 | S | Block internal users (email domain `@digitalsukoon.com`) from submitting `POST /internships/:id/apply`. |
| 54 | F-DUP-EMPLOYEE-DETECT | #54, #57 | M | On admin invite + signup: case-insensitive name match + email local-part comparison → show warning "Possible duplicate: existing user X (Y)" with override option. |
| 55 | F-AUTO-TEAM-TAG | #53 | M | Audit `apps/api/src/services/auto-team` (or similar) algorithm. |
| 56 | F-SIDEBAR-WRAP | #23, #29, #74 | S | Sidebar "More" grid: widen columns or shorten labels ("Internships" still fits in one line at slightly wider grid). Add `hyphens: manual` to prevent mid-word break. |
| 57 | F-HOLIDAY-FORM-MODAL | #39, #95 | S | Move Add Holiday inline form into a modal triggered by an "Add Holiday" button. |
| 58 | F-CURRENCY-ICON | #40 | S | Empty-state icon on Expenses: use ₹ instead of $. |
| 59 | F-DEVICES-PII | #99 | S | Hide personal emails on Devices admin table; show employee name + employee ID only. |
| 60 | F-PLATFORM-ICONS | #16 | M | Replace generic globe with platform-specific icons (Instagram, Facebook, YouTube, Twitter/X, LinkedIn). Use Lucide brand icons. |
| 61 | F-WORKLOAD-LEGEND | #18 | S | Add tooltip explaining "In:" / "Fa:" / "Yt:" prefixes, OR replace prefixes with platform icons (matches F-PLATFORM-ICONS). |
| 62 | F-JOB-DEPARTMENT-VALIDATE | #47 | S | Job admin form: Department dropdown (not free text) with fixed list. |
| 63 | F-WORKLOAD-LOADING | #35 | M | Add skeleton loader to Workload Matrix; investigate why query takes 4s — likely an N+1 in the workload service. |
| 64 | F-FOOTER-LINKS | #3 | S | Wire Status / Changelog / Security footer links to real pages or remove. |
| 65 | F-FOOTER-WHITESPACE | #4 | S | Remove extra padding/margin below landing footer. |
| 66 | F-NAV-NEWTAB | #2 | S | Landing nav: `target="_blank"` for external links. |
| 67 | F-PRESENTATIONS-LIVE-PREVIEW | TC-218 | M | Add live Marp preview pane in HR presentations editor (use `@marp-team/marp-core` client-side). |
| 68 | F-FAKE-STATS (HR) | TC-103/178 | S | Verify HR login right panel via runtime; if fake, remove or wire to real data. |
| 69 | F-LOGIN-PREVIEW-STATS | #27 | S | Same approach for internal login hero preview stats — wire to cached `/analytics/overview` snapshot or remove. |
| 70 | F-BADGE-SPACING | TC-194 | S | Client sidebar approvals badge: add `gap-2` between label and chip. |

### Wave 4 — P3 architectural / large

| # | Fix family | Items | Size | What to change |
|---|---|---|---|---|
| 71 | F-TOKEN-STORAGE | TC-110 | XL | Move JWTs from `localStorage` to httpOnly secure cookies. Touches API auth response + all 4 portals' `lib/api.ts` + root layouts that read localStorage on mount. Single dedicated PR. |
| 72 | F-NAV-RESTRUCTURE | TC-089/170 | M | Internal sidebar: pull Analytics, Workload, Expenses, Devices, Complaints, Bug Reports, AI Assistant out of "More" into labelled sections. |
| 73 | F-NAV-LABELS | TC-090/180 | S | HR sidebar: "Board" → "Leaderboard", "POA" → "Plan of Action". |
| 74 | F-CLIENT-PERF | BUG-22 | M | Profile freezing in DevTools; likely a runaway SWR poll or large render. Investigate per-page. |

### Wave 5 — Production data cleanup (operational, not code)

Run all of the following against the production DB (via admin UI or direct SQL). See §5.4 for the script.

1. Delete test announcements ("Test Announcement / Hello World")
2. Delete test tasks ("test", "demo tabish", "sdfdg")
3. Delete test content posts ("just testing", "QA Test Brief", "Demo Content Tabish")
4. Delete test clients ("Demo Client Co. Tabish", "Demo Client Co.")
5. Delete test holidays ("demo")
6. Delete test job postings ("Demo Job"); fix "Social Media Manager" (set Department, deduplicate copy, fix `2.-3` typo, set valid salary format)
7. Delete test complaints ("dsfds"/"dsfdsf"), test bug reports ("demo")
8. Delete or rename test team "Facebook" (empty), "total filmi" (lowercase); deduplicate 5× "TellyDrama Team"
9. Deduplicate sudhanshu admin (keep `admin@digitalsukoon.com`, archive the other two)
10. Title-case all employee/account names ("aniket verma" → "Aniket Verma", "mac verma" → "Mac Verma")
11. Title-case all device names ("apple macbook air" → "Apple MacBook Air", etc.)
12. Delete test internship apps ("sdsf"/"fdgfd", 2× test@test.com); delete admin self-apply
13. Lowercase all email addresses in DB (Aadhaar/PAN strip whitespace) — already partially done by `packages/db/prisma/normalize-emails.ts`
14. Fix "bollywood mirrorr" → "bollywood mirror"
15. Strip UTM/igsh from account names: e.g. `viral_paps?igsh=...` → `viral_paps`

---

## 5. Execution sequence & PR strategy

### 5.1 Suggested order

1. **Wave 1 (P0)** — 9 PRs, each independent. Ship over 2-3 days. **Block all other work until Wave 1 is done** because these are security/data-correctness.
2. **Wave 5 (data cleanup)** — Can run in parallel with Wave 1. One-time cleanup script + manual admin-UI walkthrough.
3. **Wave 2 (P1)** — 33 PRs. Group small fixes (PLURALIZATION + DATE-FORMAT + PAGE-TITLES) into a few "polish sweep" PRs to reduce churn.
4. **Wave 3 (P2)** — 21 PRs. Same sweep strategy.
5. **Wave 4 (architectural)** — 3 cards: F-NAV-RESTRUCTURE ✅, F-NAV-LABELS ✅, F-CLIENT-PERF ✅. F-TOKEN-STORAGE and F-RESPONSIVE-ALL-PORTALS deferred as XL items with disproportionate risk.

### 5.2 PR sizing summary

- **S (≤1 day):** 38 items
- **M (1-3 days):** 27 items
- **L (3-5 days):** 2 items (F-CLIENT-MOBILE, F-CLIENT-PERF investigation)
- **XL (1 week+):** 0 items (F-TOKEN-STORAGE and F-RESPONSIVE-ALL-PORTALS deferred)

### 5.3 Open verification work (runtime testing required before fix)

These items cannot be classified from static code reads — they need a running app:

| Item | What to check |
|---|---|
| BUG-10 (breadcrumb null) | Open a content detail in client portal — does breadcrumb actually render "null"? |
| BUG-14 (Feed preview no image) | Is the hatched placeholder intentional design, or should media render? |
| BUG-18 (Calendar wrong day) | Verify in browser at 12:30am IST — likely a TZ issue. |
| BUG-21 (Tasks card clipped) | Open a project detail at common viewport sizes. |
| BUG-24 (Resize logout) | Reproduce by resizing the browser while logged in. |
| TC-103/178 (HR login fake stats) | Inspect right panel — fake widgets or real data? |
| #56 (Notification bell dropdown) | Confirm bell currently navigates to /announcements vs opens dropdown. |
| #43, #82 (Follower counts 0) | Check `follower-sync.service.ts` last-run + DB row updatedAt. |

### 5.4 Production data cleanup script (sketch)

Create `scripts/cleanup-production.ts`:

```ts
// Run via: ssh linode "cd /opt/dashmani-platform && npx tsx scripts/cleanup-production.ts --dry-run"
// Then re-run without --dry-run after manual review.
```

Operations (with `--dry-run` log + confirm gate):
1. `User`: delete by id list (test entries), lowercase emails (via `normalize-emails.ts`)
2. `Account`: regex strip `\?.*$` from `username`
3. `Task`/`Content`/`Client`/`Holiday`/`Announcement`/`Complaint`/`BugReport`: delete by title/name `LIKE '%demo%' OR title IN ('test', 'sdfdg', ...)`
4. `Team`: delete `name = 'Facebook'` if 0 members; keep one `TellyDrama Team`, reassign members
5. `Internship_Application`: delete by name/college regex

⚠️ Run a `pg_dump` of production first (per `CLAUDE.md` "Database changes are NEVER run by CI/CD").

---

## 6. Per-portal sign-off checklists

Use these checklists before declaring each portal "done."

### 6.1 Internal portal sign-off
- [ ] Wave 1 items #1-6 shipped
- [ ] All 9 breadcrumbs match headings (F-BREADCRUMB-CASE)
- [ ] Dashboard count matches Employees list count
- [ ] No admin can approve own leave
- [ ] No platform-specific shortcut (⌘) shown on Windows
- [ ] All 11 stat cards wrap on small screens
- [ ] Page titles set on Tasks, Task Detail, Expenses, Attendance, AI Assistant
- [ ] Add Employee form has all HR fields
- [ ] Test/demo entries cleaned from production DB
- [ ] F-TOKEN-STORAGE shipped (when Wave 4 done)

### 6.2 HR portal sign-off
- [ ] PII (Aadhaar/PAN/Bank/IFSC) masked after save
- [ ] Status / Designation use `formatStatus()`
- [ ] One submission path for WFH (or three but with parity)
- [ ] WFH page filters server-side
- [ ] SOP DB-backed
- [ ] Company stats either real or removed
- [ ] Presentations have live preview
- [ ] Password policy ≥8 chars + complexity
- [ ] HR login fake panel verified/removed

### 6.3 Client portal sign-off
- [ ] Mobile layout works at 375px (hamburger + responsive grids)
- [ ] Window resize does NOT log user out
- [ ] All 12 listed code bugs fixed
- [ ] Footer links go somewhere real
- [ ] Search finds content posts
- [ ] Format mix chart shows data when posts have formats
- [ ] Cadence chart numbers match Total posts card

### 6.4 Cross-cutting sign-off
- [ ] All tokens in httpOnly cookies (F-TOKEN-STORAGE)
- [ ] Internal sidebar restructured (F-NAV-RESTRUCTURE)
- [ ] HR sidebar uses full names (F-NAV-LABELS)
- [ ] Workload table renders 0 / — instead of blank
- [ ] HR POA rejects future dates

---

## 7. Product decisions (locked in 2026-05-21)

These were open questions before Wave 1 started; now decided.

| # | Question | Decision | Implication |
|---|---|---|---|
| 1 | WFH / Comp-Off submission paths | **Keep all 3, ensure parity** | All three paths (Leave dropdown, `/wfh`, `/comp-off`) post to the same canonical endpoint with identical fields. WFH page must still server-filter (F-WFH-SERVER-FILTER stays in scope). No destructive page removal. |
| 2 | Settings: who can edit own name/email | **All users** | F-SETTINGS-EDITABLE simplified — remove read-only restriction globally. |
| 3 | Minimum viewport / responsive target | **All portals must be desktop + mobile responsive** | NEW: F-RESPONSIVE-ALL-PORTALS (XL) added to Wave 4. Internal, HR, and Client portals all need a responsive sweep. Mobile target = 375px. |
| 4 | Client portal mobile target width | **375px (standard mobile)** | F-CLIENT-MOBILE and F-RESPONSIVE-ALL-PORTALS use 375px as the floor. |
| 5 | HR PII masking behavior | **Mask by default, reveal-on-Edit for same session** | Show `••••••••1234` after save; clicking "Edit" reveals the value for the logged-in user. No re-type requirement. |
| 6 | Internal + HR login preview stats panel | **Wire to real cached data** | F-LOGIN-PREVIEW-STATS + F-FAKE-STATS (HR) become M-sized: need a public, cached, low-cardinality `/v1/public/stats` endpoint with cron refresh. |
| 7 | Date picker library | **Adopt `react-day-picker` monorepo-wide** | One dependency PR adds the lib + a `<DateRangePicker>` wrapper in `@dashmani/ui`. All four portals use it. |
| 8 | Production data cleanup approval | **Tabish-only, after --dry-run review** | Script writes a dry-run diff; you review the list; re-run without `--dry-run`. Single approver gate. |

---

## 8. What's NOT in this plan (intentional scope)

- **Jobs portal (`apps/jobs`)** — public-facing job listings site. No bugs filed in this round; per V2 plan, only data-cleanup items remain (Demo Job, misconfigured Social Media Manager listing) — folded into Wave 5.
- **Auth consolidation (F-AUTH-CONSOLIDATE, TC-188/219)** — three separate auth endpoints (`/auth`, `/hr/auth`, `/client/auth`) are by design (different user models). Not a bug.
- **Forgot-password localhost issue** — per `memory/project_forgot_password_status.md`, client portal reset emails point to prod URL locally because `CLIENT_APP_URL` env var is unset. Operational, not a code bug.
- **AI hallucination / reliability (TC-060/062/064/066)** — Out of scope for portal QA; that's an AI-prompt-engineering effort.
- **Infrastructure items** — SSR (TC-104), subdomain naming (TC-107) — long-term, not relevant to "free of issues."

---

---

## 9. Sonnet-ready execution cards

> **For the implementer:** Each card below is a self-contained PR-sized unit. Read the whole card before starting. The "Files" list is exhaustive — if you need to touch a file not listed, stop and ask. The "Done when" list is the acceptance test; don't mark complete until all boxes pass. "Verify with" is the runtime check.
>
> All cards assume the repo state on 2026-05-21 and the §7 decisions are locked.
> Use `npm run dev` to test locally. Use `npx tsc --noEmit -p apps/<app>/tsconfig.json` after edits to confirm types.

### Wave 1 — P0 security & data correctness (9 cards)

---

#### Card 1.1 — F-SELF-APPROVAL-GUARD (Internal)

**Issue:** #22, #66 — Admin can approve their own leave request.
**Size:** S (~1h)
**Files:**
- `apps/api/src/services/leave.service.ts` — primary
- `apps/api/src/routes/admin-features.routes.ts` — caller
- `apps/internal/src/app/approvals/page.tsx` — UI guard

**Steps:**
1. In `leave.service.ts`, find `approveLeaveRequest(requestId, approverId, ...)` and `rejectLeaveRequest(...)`. Before any DB write, fetch the request, compare `request.userId === approverId`, and throw `new ApiError(403, "SELF_APPROVAL_FORBIDDEN", "You cannot approve or reject your own leave request")`.
2. In `apps/internal/src/app/approvals/page.tsx`, where the Approve / Reject buttons render, add a condition: if `request.userId === currentUser.id`, disable both buttons and show a small tooltip "Self-approval not allowed".

**Done when:**
- [ ] Logged in as Sudhanshu, opening his own leave request shows disabled Approve / Reject buttons
- [ ] `curl -X POST /v1/admin/leave-requests/:id/approve` with same-user token returns 403 with code `SELF_APPROVAL_FORBIDDEN`
- [ ] `npx tsc --noEmit -p apps/api/tsconfig.json` clean
- [ ] `npx tsc --noEmit -p apps/internal/tsconfig.json` clean

**Verify with:** Log in as `admin@digitalsukoon.com`, create a leave for yourself via `/leave`, then open `/approvals` — your own request shows greyed-out buttons.

---

#### Card 1.2 — F-DASHBOARD-COUNT (Internal)

**Issue:** #9, #71 — Dashboard "78 Active Employees" vs Employees list "50 total".
**Size:** S (~1h)
**Files:**
- `apps/internal/src/app/dashboard/page.tsx` — primary (line 21 area)
- `apps/api/src/services/analytics.service.ts` — confirm `employeeWhere` exists
- `apps/internal/src/app/analytics/page.tsx` — check "Attendance Today" widget uses same source

**Steps:**
1. Open `analytics.service.ts` and confirm the constant `employeeWhere` (filters `status: "ACTIVE"`, `deletedAt: null`, excludes `Super Admin` + `Admin` roles) is exported or used internally.
2. Check `getDashboardOverview()` (or similar) returns a field like `employeeCount` (not `totalUsersCount`). If it returns `totalUsersCount`, replace the count query to use `employeeWhere`.
3. In `dashboard/page.tsx:21`, the "Active Employees" stat reads from the analytics overview hook. Update it to read the corrected field (`employeeCount`, not `totalUsersCount`).
4. Repeat for `analytics/page.tsx` "Attendance Today" employee count if needed.

**Done when:**
- [ ] Dashboard "Active Employees" matches the count on `/employees` (filter: Active, not deleted)
- [ ] Analytics "Attendance Today" employee count matches
- [ ] `curl /v1/analytics/overview` returns the same number as `curl /v1/employees | jq '.data | length'`

**Verify with:** Load `/dashboard` and `/employees`; numbers must match.

---

#### Card 1.3 — F-ACCOUNT-NAME-SANITIZE (Internal)

**Issue:** #36 — Account usernames contain UTM/query strings (`viral_paps?igsh=…`, `archivebollywood?utm_source=…`).
**Size:** S (~2h)
**Files:**
- `packages/shared/src/validators/account.ts` (or wherever account create/update Zod lives) — primary
- `apps/api/src/services/account.service.ts` — strip on save (defensive)
- `apps/api/src/services/bulk-import.service.ts` — strip during CSV/bulk import
- `scripts/cleanup-production.ts` (NEW — see Wave 5) — backfill existing rows

**Steps:**
1. In the account Zod schema, find the `username` (or `handle`) field. Add `.transform(v => v.split("?")[0].trim())` and `.refine(v => !/[?&=]/.test(v), "Username may not contain URL parameters")`.
2. In `account.service.ts`, on create/update, defensively strip `?...$` from the username before write (in case validator is bypassed).
3. Add an export `sanitizeAccountUsername(raw: string): string` so the cleanup script can reuse it.
4. For backfill, add an entry to `scripts/cleanup-production.ts` (see Card 5.1).

**Done when:**
- [ ] `POST /v1/accounts` with `username: "viral_paps?igsh=foo"` returns the saved row with `username: "viral_paps"`
- [ ] Bulk-importing a CSV with UTM-laden usernames produces clean values
- [ ] Existing dirty rows will be cleaned in Wave 5

**Verify with:** `curl -X POST /v1/accounts -d '{"username":"test?utm_source=x","platform":"INSTAGRAM"}'` then GET that account; username field is `test`.

---

#### Card 1.4 — F-AUTOCOMPLETE-NEW-PASSWORD (Internal)

**Issue:** #59 — Add Employee form password field auto-fills with admin's saved credentials.
**Size:** S (~30min)
**Files:**
- `apps/internal/src/app/employees/new/page.tsx` (or wherever Add Employee form lives — verify path)
- Sweep: any other admin-managed password input

**Steps:**
1. Find the Add Employee password input. Add `autoComplete="new-password"`.
2. Add `autoComplete="email"` to email field (prevents form auto-association).
3. Grep `apps/internal` for `type="password"` and audit each input — if it's a "set password for another user" context, apply `autoComplete="new-password"`.

**Done when:**
- [ ] Open `/employees/new` in a browser logged in as admin; password field does NOT pre-populate
- [ ] All password inputs in admin-managed forms have `autoComplete="new-password"`

**Verify with:** Chrome with saved admin credentials → navigate to Add Employee → password field is empty.

---

#### Card 1.5 — F-KEEP-SIGNED-DEFAULT (Internal)

**Issue:** #26 — "Keep me signed in" checked by default.
**Size:** S (~15min)
**Files:**
- `apps/internal/src/app/login/page.tsx` (around line 198)

**Steps:**
1. Find the checkbox. Remove `defaultChecked` attribute (or set `defaultChecked={false}` if controlled). Make sure the controlling `useState` initializes to `false`.

**Done when:**
- [ ] Loading `/login` shows the checkbox unchecked
- [ ] Login still works when user does check it (existing behavior preserved)

**Verify with:** Open `/login` in incognito; checkbox is empty.

---

#### Card 1.6 — F-DESTRUCTIVE-CONFIRM (Internal)

**Issue:** #37, #48 — Delete actions on Clients, Holidays, Jobs have no confirm.
**Size:** S (~1.5h)
**Files:**
- `apps/internal/src/app/clients/page.tsx` (delete button)
- `apps/internal/src/app/holidays/page.tsx` (delete button)
- `apps/internal/src/app/jobs/page.tsx` (delete button)
- Optional: `packages/ui/src/components/confirm-dialog.tsx` if not already present

**Steps:**
1. Check whether `@dashmani/ui` already exports a `ConfirmDialog`. If not, create one (Radix AlertDialog wrapper) with props: `title`, `description`, `confirmLabel`, `onConfirm`, `destructive?: boolean`.
2. Wrap each delete button click handler to open the dialog. Confirm text: "Delete {entity name}? This cannot be undone."

**Done when:**
- [ ] Clicking Delete on a client opens a confirm modal; canceling does nothing; confirming deletes
- [ ] Same for Holiday Delete and Job Delete
- [ ] No accidental single-click deletion possible

**Verify with:** On `/clients`, `/holidays`, `/jobs` — click Delete on any row; modal appears.

---

#### Card 1.7 — F-PII-MASKING (HR)

**Issue:** TC-208 — Aadhaar / PAN / Bank A/c / IFSC plain text after save.
**Decision (§7 #5):** Mask by default, reveal-on-Edit for same session.
**Size:** M (~3h)
**Files:**
- `apps/hr/src/app/profile/page.tsx` — primary (lines 141, 181, 185 area)
- `apps/hr/src/lib/utils/mask.ts` (NEW — small utility)

**Steps:**
1. Create `apps/hr/src/lib/utils/mask.ts` with `maskPII(value: string, visibleLast: number = 4): string` that returns `"••••••" + value.slice(-visibleLast)`. Handle empty / null.
2. In `profile/page.tsx`, for each of the four fields (Aadhaar, PAN, Bank Account, IFSC), introduce per-field local state `editingAadhaar`, `editingPan`, etc. (boolean).
3. Render logic: if `editing[X] === false` and value exists, show masked + "Edit" button next to it. If `editing[X] === true`, show the editable `<input>` with the real value. On Save (existing save handler), set all editing states back to false.
4. After saving a new value, briefly leave it un-masked for 5 seconds, then re-mask (UX nicety, optional).
5. PAN: mask all but last 4 (`••••••1234`). Aadhaar: same. Bank Account: same. IFSC: mask all but last 4.

**Done when:**
- [ ] After fresh page load, all four PII fields display as `••••••XXXX`
- [ ] Clicking "Edit" next to a field reveals the real value in an editable input
- [ ] Saving a new value re-masks the field
- [ ] Navigating away and back re-masks (no localStorage reveal persistence)

**Verify with:** Log in to HR portal → `/profile` → confirm fields are masked → click Edit on Aadhaar → real value appears → save → masked again.

---

#### Card 1.8 — F-CLIENT-RESIZE-LOGOUT (Client)

**Issue:** BUG-24 — Window resize invalidates user session.
**Size:** M (~2h, includes runtime repro)
**Files:**
- `apps/client/src/app/layout.tsx` (lines 17-26 area)
- Possibly `apps/client/src/lib/api.ts` if token-loading is racy

**Steps:**
1. **First reproduce.** Run `npm run dev -w @dashmani/client`. Log in. Open DevTools → Performance + Console. Resize the window. Watch for: (a) any redirect, (b) any localStorage clear, (c) any 401.
2. The likely cause: a `useEffect` with `[pathname, router]` deps re-runs on a re-render triggered by resize, and reads `localStorage` before the token has been hydrated. Verify by adding a `console.log("auth check", { hasToken: !!localStorage.getItem("clientAccessToken") })` to the effect.
3. Fix: gate the redirect on a `mounted` state that's only set in a `useEffect(() => { setMounted(true); }, [])`. Don't redirect until `mounted === true`.
4. Alternative fix: switch the effect to depend only on `[pathname]`, not `[pathname, router]` (router is stable but Next sometimes re-creates it).

**Done when:**
- [ ] Resize the window repeatedly while logged in — no redirect to `/login`
- [ ] Existing pathname-change auth check still works
- [ ] Logout still works
- [ ] `localStorage.getItem("clientAccessToken")` is read at most once per real navigation

**Verify with:** Log into client portal → drag window edge to resize 10 times → stay logged in.

---

#### Card 1.9 — F-CLIENT-MOBILE-MINIMAL (Client)

**Issue:** BUG-23 — No mobile layout below 640px.
**Decision (§7 #4):** Target 375px floor.
**Size:** L (~5h for client portal alone; full responsive sweep moves to Card 4.x)
**Files:**
- `apps/client/src/components/portal-rail.tsx` (sidebar)
- `apps/client/src/app/layout.tsx` (main grid)
- `apps/client/src/components/portal-shared.tsx` (any layout containers)
- All client pages with `min-w-` or fixed widths — sweep

**Steps:**
1. In `portal-rail.tsx`, wrap the rail in `hidden lg:block`. Add a separate mobile top bar component with a hamburger button that opens the rail in a Radix Sheet (slide-in drawer).
2. In root `layout.tsx`, change the grid from `grid-cols-[220px_1fr]` (or similar) to `lg:grid-cols-[220px_1fr] grid-cols-1`. Below `lg`, content takes full width.
3. Audit each page for fixed widths (`w-[1024px]`, `min-w-[800px]`). Replace with `max-w-screen-xl mx-auto px-4 lg:px-8`.
4. Audit tables — wrap in `<div class="overflow-x-auto">` so they scroll horizontally below `lg` instead of breaking layout.
5. Test at 375px width in Chrome DevTools device toolbar. Pages to verify: `/login`, `/dashboard`, `/projects`, `/projects/[id]`, `/content`, `/content/[id]`, `/approvals`, `/analytics`, `/files`.

**Done when:**
- [ ] At 375px width: sidebar is hidden; hamburger opens a drawer rail
- [ ] All listed pages render without horizontal scrollbar on the body
- [ ] Tables scroll horizontally inside their container
- [ ] Modals (New Brief, Forgot Password) are full-width below `lg`

**Note:** This card is the **client-only** minimal responsive pass. The full cross-portal responsive sweep (Internal + HR) is **Card 4.4 F-RESPONSIVE-ALL-PORTALS** in Wave 4 — that's where Tailwind tokens and shared layout patterns get standardised. This card is enough to ship Client portal mobile support immediately.

**Verify with:** Chrome DevTools → Device Toolbar → iPhone SE (375x667). Walk through every client page.

---

### Wave 2 — P1 broken / misleading UX (33 cards)

> **Bundling strategy:** Many of these are <1h fixes. Group them into themed "polish sweep" PRs to reduce PR count. Suggested bundles below.

#### Bundle 2A — "Login / Forgot password polish" (Cards 2.1–2.4, one PR)

**Files (PR scope):**
- `apps/internal/src/app/login/page.tsx`
- (any forgot-password modal component used by it)

---

#### Card 2.1 — F-PLATFORM-SHORTCUT (Internal)

**Issue:** #1, #25 — Mac ⌘K shown on Windows.
**Size:** S (~30min)
**Files:**
- `apps/internal/src/components/top-nav.tsx` (around line 119)
- `apps/internal/src/app/login/page.tsx` (hero shortcut)
- New: `apps/internal/src/lib/utils/platform.ts`

**Steps:**
1. Create `platform.ts` with `isMac()`: returns `typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)`. SSR-safe.
2. Create a small React component `<KbdShortcut>` that renders `⌘K` on Mac, `Ctrl K` on Windows/Linux. Make it client-only (`"use client"`) to avoid hydration mismatch — initialize state to `null` and set in `useEffect`.
3. Replace hardcoded `⌘K` in top-nav and login hero with `<KbdShortcut keys={["K"]} />`.

**Done when:**
- [ ] On macOS Safari/Chrome: shows `⌘K`
- [ ] On Windows Chrome: shows `Ctrl K`
- [ ] No hydration warning in dev console

**Verify with:** Toggle DevTools → "Sensors" → User Agent → Windows. Refresh; should show `Ctrl K`.

---

#### Card 2.2 — F-LOGIN-VALIDATION (Internal)

**Issue:** #5 — Empty email field shows only "Password is required".
**Size:** S (~30min)
**Files:** `apps/internal/src/app/login/page.tsx`

**Steps:**
1. Find the submit handler. Validate `email.trim() === ""` independently from password; set both error states.
2. Show inline errors under each field via existing error pattern.

**Done when:**
- [ ] Submit empty form → both fields show errors
- [ ] Submit with valid email + empty password → only password error
- [ ] Submit with valid email + valid password → login proceeds

**Verify with:** `/login` → click Sign In with empty form → both errors appear.

---

#### Card 2.3 — F-FORGOT-MODAL-CTA (Internal)

**Issue:** #6, #7 — Forgot password modal uses browser-native validation; success state has no "Back to sign in" button.
**Size:** S (~45min)
**Files:** `apps/internal/src/app/login/page.tsx` (forgot modal component)

**Steps:**
1. Replace `<input required type="email">` browser-native validation with the same inline-error pattern used by main login form.
2. In the success state ("Reset link sent"), add a "Back to sign in" button that closes the modal and refocuses the email field.

**Done when:**
- [ ] Submitting empty forgot-password form shows custom inline error, not browser tooltip
- [ ] After success, a button labeled "Back to sign in" closes the modal

---

#### Card 2.4 — F-LOGIN-PREVIEW-STATS (Internal + HR)

**Issue:** #27, TC-103, TC-178 — Login page preview stats all show 0 / hardcoded.
**Decision (§7 #6):** Wire to real cached data.
**Size:** M (~3h)
**Files:**
- `apps/api/src/routes/public.routes.ts` (NEW or add to `health.routes.ts`)
- `apps/api/src/services/analytics.service.ts` — add `getPublicStatsSnapshot()`
- `apps/api/src/cron/public-stats-refresh.ts` (NEW)
- `apps/internal/src/app/login/page.tsx`
- `apps/hr/src/app/login/page.tsx`

**Steps:**
1. Add endpoint `GET /v1/public/stats` (no auth required) returning `{ employeeCount, activeProjects, postsPublishedThisMonth }`. Use the `employeeWhere` filter. Cache the result in Redis with key `public:stats` and 1-hour TTL.
2. Add cron `public-stats-refresh.ts` running every hour to refresh the Redis cache.
3. In internal login page, replace hardcoded stats (around line 405-408) with `useSWR("/v1/public/stats", apiFetchPublic)`. Fallback to skeleton.
4. In HR login page right panel, replace any fake widgets with the same fetcher.

**Done when:**
- [ ] `curl /v1/public/stats` returns real cached numbers
- [ ] Internal login hero shows real employee count
- [ ] HR login right panel shows real stats (or is removed if it was decorative)
- [ ] Endpoint doesn't require auth and rate-limits at 60 req/min

**Verify with:** `curl http://localhost:4000/v1/public/stats` → returns JSON with real counts.

---

#### Bundle 2B — "Plural & date format sweep" (Cards 2.5–2.9, one PR)

---

#### Card 2.5 — F-PLURALIZATION

**Issue:** #12, #19, #77, #87 — "1 members", "1 projects".
**Size:** S (~1h)
**Files:**
- `packages/shared/src/utils/pluralize.ts` (NEW)
- `packages/shared/src/index.ts` (export)
- `apps/internal/src/app/teams/page.tsx:149`
- `apps/internal/src/app/clients/page.tsx:81`
- Grep usage across all portals

**Steps:**
1. Create `pluralize(count, singular, plural?)`: if `count === 1` return `${count} ${singular}`; else `${count} ${plural ?? singular + "s"}`.
2. Replace `{count} members` / `{count} projects` / `{count} tasks` etc. across `apps/internal`, `apps/hr`, `apps/client`.

**Done when:**
- [ ] `pluralize(1, "member")` → `"1 member"`
- [ ] `pluralize(2, "member")` → `"2 members"`
- [ ] No `${X} members` strings remain in JSX

**Verify with:** Teams page with 1 member shows "1 member"; with 2 shows "2 members".

---

#### Card 2.6 — F-REPORTS-DATE-FORMAT + F-DATE-FORMAT-ATTENDANCE

**Issue:** #31, #33, #91 — Raw ISO dates leaking to UI.
**Size:** S (~1h)
**Files:**
- `apps/internal/src/app/reports/page.tsx` (line 60 area — Today stat card)
- `apps/internal/src/app/attendance/page.tsx` (date column)
- `packages/shared/src/utils/date.ts` — add `formatDate(d: string | Date): string` returning "20 May 2026"

**Steps:**
1. Add `formatDate` to shared utils (`Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" })`).
2. Replace raw ISO renders with `formatDate(value)`.

**Done when:**
- [ ] Reports "Today" card shows "20 May 2026"
- [ ] Attendance date column shows "11 May 2026"

---

#### Card 2.7 — F-PAGE-TITLES-INTERNAL-2

**Issue:** #61, #75 — Page titles missing on Tasks, Task Detail, Expenses, Attendance, AI Assistant.
**Size:** S (~30min)
**Files:**
- `apps/internal/src/app/tasks/page.tsx`
- `apps/internal/src/app/tasks/[id]/page.tsx`
- `apps/internal/src/app/expenses/page.tsx`
- `apps/internal/src/app/attendance/page.tsx`
- `apps/internal/src/app/ai-assistant/page.tsx`

**Steps:** Add `usePageTitle("Tasks")` (etc.) to each page component, top of body.

**Done when:**
- [ ] Each browser tab shows `<Page> — Dashmani Portal`
- [ ] Grep for files importing `usePageTitle` shows all 5

---

#### Card 2.8 — F-BREADCRUMB-CASE

**Issue:** #38, #55, #68, #79, #83, #90, #93, #96, #100, #101 — Breadcrumb capitalisation inconsistent with page headings across 10 pages.
**Size:** M (~2h)
**Files:**
- `apps/internal/src/components/sidebar.tsx` (label source)
- All page headings in `apps/internal/src/app/*/page.tsx`

**Steps:**
1. Pick **canonical names** (use the heading, not the breadcrumb, as truth): "Salary Slips", "Offer Letters", "Bug Reports", "AI Assistant", "Team Structure", "Workload Matrix", "Holiday Calendar", "Assigned Devices", "Employee Complaints", "Daily Reports", "Auto-Detected Teams", "Expense Claims".
2. Find the sidebar `label` for each route and update.
3. Verify each page heading also uses the canonical form.

**Done when:**
- [ ] For each of the 10 pages, breadcrumb label === page heading
- [ ] Grep for "Salary slips" (lowercase s) across `apps/internal` returns 0 hits

---

#### Card 2.9 — F-LEADERBOARD-BTN-STYLE

**Issue:** #92 — Leaderboard button on Reports page is yellow.
**Size:** S (~15min)
**Files:** `apps/internal/src/app/reports/page.tsx`

**Steps:** Change button variant to the shared primary (black) style used elsewhere.

**Done when:**
- [ ] Leaderboard button matches other primary CTAs

---

#### Bundle 2C — "Form validation & affordance sweep" (Cards 2.10–2.13, one PR)

---

#### Card 2.10 — F-TASK-TITLE-VALIDATION + F-AI-CHAT-EMPLOYEE-VALIDATE

**Issue:** #63 (Task), #67 (AI Chat).
**Size:** S (~1h total)
**Files:**
- `apps/internal/src/app/tasks/page.tsx` (or new-task modal)
- `apps/internal/src/app/ai-assistant/page.tsx`

**Steps:**
1. Task form: on submit, if `title.trim() === ""`, set error state and show "Title is required" red text + red border. Don't submit.
2. AI Chat: on send, if `selectedEmployee == null`, show inline error "Please select an employee" above the input. Don't fire.

**Done when:**
- [ ] Empty Task title → red error, no submit
- [ ] AI Chat send without employee → red error, no API call

---

#### Card 2.11 — F-TASK-DUE-OVERFLOW

**Issue:** #62 — "Due:" label cut off to "D".
**Size:** S (~15min)
**Files:** `apps/internal/src/app/tasks/[id]/page.tsx`

**Steps:** Find the "Due:" label container; remove `overflow:hidden` or `text-overflow:ellipsis` or increase `min-w`.

**Done when:** Task detail "Due:" label is fully visible.

---

#### Card 2.12 — F-ROLE-CHIP-STATE

**Issue:** #58 — Role chips don't show which is selected.
**Size:** S (~1h)
**Files:** `apps/internal/src/app/employees/[id]/page.tsx` (Edit Employee, roles section)

**Steps:**
1. Render selected roles with a filled background + checkmark; unselected with outline.
2. Use Tailwind `data-[selected=true]:bg-ink data-[selected=true]:text-white` pattern.

**Done when:**
- [ ] Editing an employee shows the assigned role(s) with a clear visual fill
- [ ] Clicking an unselected chip toggles selection
- [ ] Save persists the selection

---

#### Card 2.13 — F-ADD-EMPLOYEE-FIELDS

**Issue:** #60 — Add Employee form missing Designation, Department, Join Date, Salary, Team.
**Size:** M (~3h)
**Files:**
- `apps/internal/src/app/employees/new/page.tsx` (form)
- `packages/shared/src/validators/employee.ts` (Zod schema)
- `apps/api/src/services/employee.service.ts` (write logic)
- `packages/db/prisma/schema.prisma` — verify these fields exist on `User`/`EmployeeProfile`

**Steps:**
1. Check Prisma schema — if `designation`, `department`, `joinDate`, `salary`, `teamId` exist, just add inputs. If not, this needs schema changes + `db:push`.
2. Add inputs with placeholders + required markers. Team is a dropdown of existing teams (fetch via `/v1/teams`).
3. Extend Zod validator with optional fields (so admin can leave blank initially).
4. Backend: persist all five fields on user create.

**Done when:**
- [ ] Add Employee form has all 5 fields
- [ ] Submitting with all filled persists them
- [ ] Returning to the employee detail shows the saved values

---

#### Bundle 2D — "Empty states & misc UX" (Cards 2.14–2.20, one PR)

---

#### Card 2.14 — F-ANNOUNCEMENT-EMPTY

**Issue:** #8 — Dashboard announcement banner empty.
**Size:** S (~45min)
**Files:** `apps/internal/src/app/dashboard/page.tsx` (announcement card area)

**Steps:**
1. Fetch latest announcement via `/v1/announcements?limit=1`.
2. If exists, render title + first 80 chars of body. If empty, render "No announcements yet" + the Send button.

---

#### Card 2.15 — F-EMPLOYEE-TEAM-COLUMN

**Issue:** #30 — TEAM column empty for almost all employees.
**Size:** S (~1h)
**Files:**
- `apps/api/src/services/employee.service.ts` (list query)
- `apps/internal/src/app/employees/page.tsx` (column render)

**Steps:**
1. Confirm the list query includes the team relation (`include: { teams: true }` or join).
2. Render `employee.teams[0]?.name ?? "—"`.
3. If actual data is missing in DB, that's a separate data-cleanup item — note in Wave 5.

---

#### Card 2.16 — F-DASHBOARD-RESPONSIVE (interim, replaced by Card 4.4)

**Note:** Skip this individual card; rolled into F-RESPONSIVE-ALL-PORTALS (Card 4.4) per §7 decision #3.

---

#### Card 2.17 — F-ATTENDANCE-ANALYTICS

**Issue:** #24 — Analytics > Attendance Today shows 0% despite 78 employees.
**Size:** M (~2h diagnostic + fix)
**Files:**
- `apps/api/src/services/analytics.service.ts` (attendance query)
- `apps/api/src/services/attendance.service.ts`

**Steps:**
1. **Diagnose:** Open Prisma Studio (`npm run db:studio`). Check `Attendance` table — are there any rows for today's date? If not, the bug is upstream (attendance not being recorded). If yes, the bug is the query.
2. If query bug: likely the same UTC/IST timezone trap from `memory/feedback_utc_date_timezone.md`. The query uses `new Date()` local-midnight which is the previous day in UTC. Switch to `Date.UTC(yyyy, mm, dd)`.
3. If no records exist: surface that — the page should show "No attendance recorded today" rather than "0%".

**Done when:**
- [ ] If today has attendance: Analytics shows correct present/late/absent
- [ ] If today has no attendance: page shows informative empty state

---

#### Card 2.18 — F-NOTIFICATION-DROPDOWN

**Issue:** #56 — Bell navigates to /announcements; should open dropdown.
**Size:** M (~3h)
**Files:**
- `apps/internal/src/components/top-nav.tsx` (bell button)
- New: `apps/internal/src/components/notifications-popover.tsx`
- `/v1/notifications` endpoints (verify exist; if not, add to `notification.routes.ts`)

**Steps:**
1. Replace `<a href="/announcements">` with `<Popover>` (Radix).
2. Popover content: fetch `/v1/notifications?limit=20`, render list with read/unread state, "Mark all read" action.
3. Empty state: "No notifications".

**Done when:**
- [ ] Click bell → popover opens
- [ ] Notifications listed; click marks as read
- [ ] Badge count on bell updates after mark-read

---

#### Card 2.19 — F-HISTORY-BUTTON-LABEL

**Issue:** #64 — "History" button on top nav links to /announcements.
**Size:** S (~15min)
**Files:** `apps/internal/src/components/top-nav.tsx`

**Steps:** Rename label to "Announcements", swap icon to megaphone (Lucide `Megaphone`).

---

#### Card 2.20 — F-SETTINGS-EDITABLE

**Issue:** #69 — Super Admin can't edit own name/email on Settings.
**Decision (§7 #2):** All users can edit their own.
**Size:** S (~1h)
**Files:** `apps/internal/src/app/settings/page.tsx`

**Steps:**
1. Remove the read-only restriction. Make name and email editable for all users.
2. On submit, PUT `/v1/auth/me` (or appropriate endpoint).
3. Email change should trigger an email-verification step — out of scope for this card, just allow the value change with the server-side guard already in place.

**Done when:**
- [ ] Any logged-in user can edit name + email on /settings
- [ ] Save persists
- [ ] Read-only "contact admin" message removed

---

#### Card 2.21 — F-PWD-SHOW-HIDE

**Issue:** #70 — Settings change-password missing eye toggle.
**Size:** S (~30min)
**Files:** `apps/internal/src/app/settings/page.tsx` (change password section)

**Steps:** Add eye-icon toggle to each of 3 fields (current, new, confirm). Toggle `type` between `password` and `text`.

---

#### Card 2.22 — F-FOLLOWER-SYNC

**Issue:** #43, #82 — Account follower counts show 0 for most accounts.
**Size:** M (~3h diagnostic)
**Files:**
- `apps/api/src/services/follower-sync.service.ts`
- `apps/api/src/cron/` (any follower-sync cron)
- `apps/internal/src/app/accounts/page.tsx` (show last-sync time per account)

**Steps:**
1. Check whether the sync cron is bootstrapped in `apps/api/src/index.ts`.
2. Check last-run timestamps. If never run, fix the cron. If runs but doesn't update, fix the service.
3. On the Accounts list, show "Last synced X ago" per account; add a "Sync now" admin button calling a manual sync endpoint.

**Done when:**
- [ ] Cron runs hourly (or on schedule)
- [ ] Each account shows last-sync time
- [ ] Real follower counts appear

---

#### Cards 2.23–2.32 — Client portal Wave 2 (10 cards)

For brevity in this document, each Client card below has just the essentials. The pattern matches the cards above.

**Card 2.23 — F-CLIENT-FOOTER-LINKS (BUG-04, S, 30min)**
File: `apps/client/src/app/login/page.tsx:425-427`
Route Terms/Privacy to `https://digitalsukoon.com/terms` and `/privacy` (or remove Status link if no page exists).

**Card 2.24 — F-CLIENT-NAV-LINKS (BUG-02, BUG-03, S, 30min)**
File: `apps/client/src/app/login/page.tsx:109,111`
Set distinct URLs (`/work` vs `/studio` on digitalsukoon.com) + `target="_blank" rel="noopener"`.

**Card 2.25 — F-CLIENT-AUTHOR-FALLBACK (BUG-12, S, 15min)**
File: `apps/client/src/app/content/[id]/page.tsx:161`
Fallback chain: `post.authorName ?? post.authorEmail ?? "—"`.

**Card 2.26 — F-CLIENT-SEARCH-POSTS (BUG-16, M, 2h)**
File: `apps/client/src/components/command-palette.tsx:78-90`
Add post search: fetch `/v1/client/content?search={q}&limit=10`; merge results into the palette list.

**Card 2.27 — F-CLIENT-CADENCE-DATA (BUG-20, M, 2h)**
File: `apps/client/src/app/analytics/page.tsx:136-150`
Replace hardcoded `WEEKLY_DATA` with real `/v1/client/analytics` data. Ensure total matches Total Posts card.

**Card 2.28 — F-CLIENT-STORY-PREVIEW (BUG-13, M, 2h)**
File: `apps/client/src/components/ig-previews.tsx:101-118`
Render `post.media[0].url` (or first image/video) in story preview instead of `ig-hatch-dark` placeholder.

**Card 2.29 — F-CLIENT-FILES-HEADER-GAP (BUG-17, S, 15min)**
File: `apps/client/src/app/files/page.tsx:253`
Grid columns: change `80px 80px` to `100px 100px` and add `gap-2` between Size and Uploaded headers.

**Card 2.30 — F-CLIENT-TAB-COUNT (BUG-15, S, 30min)**
File: `apps/client/src/app/content/page.tsx:65`
Add `count` prop matching the count of revision/rejected posts.

**Card 2.31 — F-CLIENT-FORMAT-MIX (BUG-19, S, 30min — verify after BUG-11 fix)**
File: `apps/client/src/app/analytics/page.tsx:143,203-204`
Verify the chart now shows data (BUG-11 fixed format=null at save layer). If posts have format values, chart should populate.

**Card 2.32 — F-CLIENT-HOWITWORKS-STATS (BUG-06, S, 30min)**
File: `apps/client/src/app/login/page.tsx:378-388`
If design-intentional, ignore. If meant to be dynamic, wire to `/v1/public/stats` (created in Card 2.4).

---

#### Cards 2.33–2.36 — HR portal Wave 2 (4 cards)

**Card 2.33 — F-STATUS-LABELS (HR) (TC-209/210, S, 30min)**
File: `apps/hr/src/app/profile/page.tsx:114,121`
Wrap `profile.status` and `profile.designation` with `formatStatus()` from `@dashmani/shared`.

**Card 2.34 — F-WFH-SERVER-FILTER (TC-115, S, 1h)**
Files: `apps/hr/src/app/wfh/page.tsx:18`, `apps/api/src/routes/hr-features.routes.ts` (GET /hr/leave-requests)
Pass `?type=WFH` to the API; server-side filter in `WHERE` clause. Same for `/comp-off`.

**Card 2.35 — F-PASSWORD-STRENGTH (TC-129, S, 1h)**
File: `apps/hr/src/app/profile/page.tsx:245` + HR signup form
Add regex validator: 8+ chars, 1 uppercase, 1 digit, 1 special (`/^(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/`).

**Card 2.36 — F-HARDCODED-STATS (TC-212, S, 1h)**
File: `apps/hr/src/app/company/page.tsx:46-48`
Either fetch from `/v1/public/stats` (now exists per Card 2.4) or remove the stats block.

---

### Wave 3 — P2 polish & data quality (21 cards)

> Group these into 2–3 PRs by theme.

#### Bundle 3A — "Naming & casing sweep" (Cards 3.1–3.4)

**Card 3.1 — F-NAME-CASE (S, 1h)**
Apply Title-Case formatter at render layer to all employee/team/account name displays. Use `toTitleCase(name)` util in `packages/shared/src/utils/`.

**Card 3.2 — F-DEVICE-NAME-CASE (S, 30min)**
Same util applied to Device names.

**Card 3.3 — F-INTERNSHIP-EMAIL-NORMALIZE (#51, S, 30min)**
Apply `normalizedEmail` Zod schema to the internship application form. Backfill handled in Wave 5.

**Card 3.4 — F-INTERNSHIP-SELF-APPLY (#49, S, 1h)**
Block emails matching `@digitalsukoon.com` from `POST /internships/:id/apply`. Return 403 with clear message.

#### Bundle 3B — "Duplicate detection" (Cards 3.5–3.6)

**Card 3.5 — F-DUP-EMPLOYEE-DETECT (#54, #57, M, 3h)**
On admin invite + signup: case-insensitive name match + email local-part comparison via Levenshtein ≥0.85. Show "Possible duplicate: X (Y)" warning with override option.

**Card 3.6 — F-AUTO-TEAM-TAG (#53, M, 3h)**
Audit auto-detection algorithm in (find via grep `auto.team` or `autoTeam`). Likely a string-matching bug — fix and add unit test.

#### Bundle 3C — "Layout & icons sweep" (Cards 3.7–3.13)

**Card 3.7 — F-SIDEBAR-WRAP (#23, #29, #74, S, 45min)**
File: `apps/internal/src/components/sidebar.tsx`
Widen "More" grid columns OR shorten labels. Add `hyphens: manual; word-break: keep-all;` CSS.

**Card 3.8 — F-HOLIDAY-FORM-MODAL (#39, #95, S, 1h)**
Move Add Holiday inline form into a modal triggered by "Add Holiday" button.

**Card 3.9 — F-CURRENCY-ICON (#40, S, 15min)**
Expenses empty-state: use `₹` (Lucide `IndianRupee`) instead of `$`.

**Card 3.10 — F-DEVICES-PII (#99, S, 30min)**
Hide personal emails on Devices admin table; show employee name + employee ID only.

**Card 3.11 — F-PLATFORM-ICONS (#16, M, 2h)**
Replace generic globe with Instagram/Facebook/YouTube/Twitter/LinkedIn icons (Lucide brand or react-icons).

**Card 3.12 — F-WORKLOAD-LEGEND (#18, S, 30min)**
File: workload page table
Replace "In:" / "Fa:" / "Yt:" prefixes with platform icons (matches Card 3.11) OR add tooltip explaining the prefixes.

**Card 3.13 — F-JOB-DEPARTMENT-VALIDATE (#47, S, 1h)**
File: `apps/internal/src/app/jobs/new/page.tsx` (or edit form)
Department: change `<input>` to `<select>` with fixed list. Update Zod.

#### Bundle 3D — "Performance & cleanup" (Cards 3.14–3.21)

**Card 3.14 — F-WORKLOAD-LOADING (#35, M, 2h)**
File: `apps/internal/src/app/workload/page.tsx` + workload service
Add skeleton loader; investigate N+1 query in service (use Prisma `include` aggregation).

**Card 3.15 — F-FOOTER-LINKS (#3, S, 15min)**
Wire Status/Changelog/Security to real pages or remove from footer.

**Card 3.16 — F-FOOTER-WHITESPACE (#4, S, 15min)**
Remove extra padding/margin below landing footer.

**Card 3.17 — F-NAV-NEWTAB (#2, S, 15min)**
Landing nav: add `target="_blank" rel="noopener"` to external links.

**Card 3.18 — F-PRESENTATIONS-LIVE-PREVIEW (TC-218, M, 4h)**
File: `apps/hr/src/app/presentations/page.tsx`
Add live Marp preview pane using `@marp-team/marp-core` client-side. Split editor + preview panes.

**Card 3.19 — F-BADGE-SPACING (TC-194, S, 15min)**
File: `apps/client/src/components/portal-rail.tsx`
Add `gap-2` between sidebar label and badge chip.

**Card 3.20 — F-WORKLOAD-COLUMNS (TC-095/143/166, S, 30min)**
Workload Matrix Critical/High cells: render `0` or `—` instead of blank. Restore column headers.

**Card 3.21 — F-POA-DATE (TC-007/217, S, 1h)**
File: HR POA page + validator
Zod refine rejecting `date > today`. Add `react-day-picker` date picker (after Card 4.x lib is added).

---

### Wave 4 — Architectural & responsive (3 cards shipped; 2 deferred)

#### Card 4.2 — F-NAV-RESTRUCTURE (M, 1 day)

**Issue:** TC-089/170 — Internal sidebar "More" hides too much.
**Size:** M
**File:** `apps/internal/src/components/sidebar.tsx`

**Steps:**
1. Restructure sidebar into labelled sections: "People", "Work", "Analytics", "Tools".
2. Pull Analytics, Workload, Expenses, Devices, Complaints, Bug Reports, AI Assistant out of "More" into the appropriate section.
3. Keep "More" for genuinely rare items (Settings, Help, AutoTeams).

---

#### Card 4.3 — F-NAV-LABELS (S, 30min)

**Issue:** TC-090/180 — HR sidebar "Board" / "POA" abbreviations.
**File:** HR sidebar component.

**Steps:** Rename "Board" → "Leaderboard"; "POA" → "Plan of Action".

---

#### Card 4.5 — F-CLIENT-PERF (M, 3 days)

**Issue:** BUG-22 — Page frequently freezes.
**Size:** M (investigative)
**Files:** TBD after profiling.

**Steps:**
1. Run client portal in production-like mode (`npm run build && npm run start`).
2. Use Chrome DevTools Performance recorder during navigation Content → Project Detail → Analytics.
3. Identify long tasks (>200ms) and SWR re-fetch loops.
4. Likely culprits: aggressive SWR `refreshInterval`, large unmemoized list renders, missing `useCallback` on chart props.

**Done when:**
- [ ] No long tasks >500ms during normal navigation
- [ ] No tab freezing reproducible

---

### Wave 5 — Production data cleanup (1 card + script)

#### Card 5.1 — Cleanup script

**Decision (§7 #8):** Tabish-only approval after `--dry-run` review.
**Size:** M (~3h to write, ~1h to review + run)
**File:** `scripts/cleanup-production.ts` (NEW)

**Steps:**

1. Create `scripts/cleanup-production.ts`. Use `tsx` + Prisma client. Accept `--dry-run` flag (default true — must pass `--apply` to actually delete).
2. Implement operations as functions, each returning a `{ table, action, ids[], preview[] }` report:

```ts
async function deleteTestAnnouncements() { ... }
async function deleteTestTasks() { ... }
async function deleteTestContent() { ... }
async function deleteTestClients() { ... }
async function deleteTestHolidays() { ... }
async function deleteTestJobs() { ... }
async function fixSocialMediaManagerJob() { ... }   // update, not delete
async function deleteTestComplaints() { ... }
async function deleteTestBugReports() { ... }
async function cleanupTeams() { ... }               // delete Facebook (empty), rename "total filmi", merge 5x TellyDrama
async function deduplicateAdmins() { ... }          // archive duplicate sudhanshu entries
async function titleCaseEmployeeNames() { ... }     // 50 employees
async function titleCaseAccountNames() { ... }
async function titleCaseDeviceNames() { ... }
async function deleteTestInternshipApps() { ... }
async function deleteAdminInternshipApp() { ... }
async function lowercaseEmails() { ... }            // reuse normalize-emails.ts
async function fixBollywoodMirrorr() { ... }
async function stripUtmFromAccountNames() { ... }   // reuse sanitizeAccountUsername from Card 1.3
```

3. Each function:
   - Queries matching rows
   - Prints `"[DRY-RUN] Would delete N rows from table X: [id1, id2, ...]"` with row previews
   - If `--apply` is set, executes within a transaction
   - Logs a final report

4. Add safety: refuse to run unless `--confirm-prod` flag is also passed.

**Done when:**
- [ ] `npx tsx scripts/cleanup-production.ts --dry-run` prints a complete change preview
- [ ] After Tabish review, `npx tsx scripts/cleanup-production.ts --apply --confirm-prod` executes successfully
- [ ] Post-run: production has no test/demo entries, all names Title-Cased, all emails lowercase, account usernames stripped of UTM

**Verify with:** Run dry-run; review output; spot-check that production no longer shows "Demo Job", "Test Announcement", "viral_paps?igsh=…", etc.

---

## 10. Implementer guidance (for Sonnet at medium effort)

- **Pick cards from one Wave at a time.** Don't skip ahead.
- **One card = one PR**, unless the card explicitly says "Bundle X" — then the bundle is one PR.
- **Before starting any card**, re-read its "Files" list. If your fix needs to touch a file not listed, **stop and ask** rather than expanding scope.
- **Always run `npx tsc --noEmit -p apps/<app>/tsconfig.json` after edits.** If it errors, fix before commit.
- **Full `npm run build` before pushing** — auth pages and shared components can break in the full build but not the per-app type check.
- **Verify locally before declaring done.** Each card has a "Verify with" step — run it.
- **If `db:push` is required** (Cards 2.13, 3.18 might be), note in PR description so the deploy step on Linode includes it.
- **Don't write tests unless the card asks for one** — the repo doesn't have a frontend test harness; backend tests in `apps/api/tests/`.
- **Commit format:** `<type>(<scope>): <description>` — e.g. `fix(internal): prevent admin self-approval of leave`.
- **No emojis in code or commits.** Markdown plans may use them sparingly.
- **If a card is L or XL**, propose splitting it before starting.

**End of plan.** Once Waves 1–3 plus Wave 5 ship and the §6 sign-off checklists are green, the three portals are issue-free for the listed QA scope. Wave 4 (architectural + responsive) ships on its own cadence after.
