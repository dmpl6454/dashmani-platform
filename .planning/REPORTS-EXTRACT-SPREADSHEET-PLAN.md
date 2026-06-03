# Reports — Extract to Spreadsheet (.xlsx) — Design & Plan

**Status:** ✅ SHIPPED to localhost 2026-06-03. **NOT pushed to prod (per user).** When deploying later: `db:push` (additive `first_seen_at` column) THEN run `packages/db/prisma/backfill-first-seen.ts` once.

### What was built (verified)
- `ReportLink.firstSeenAt` column + `@@index`; preserved per-URL across resubmits in `submitDailyReport` (integration test green).
- `packages/db/prisma/backfill-first-seen.ts` (idempotent; sets first_seen_at = created_at).
- Shared date helpers: `istTimeOfDay`, `istDateTime`, `avgIstTimeOfDay` in `packages/shared/src/utils/date.ts`.
- `apps/api/src/services/report-export.service.ts` — pure `buildExportRows` + `gatherReportExportData` + `buildReportsWorkbook` (uses the already-present `xlsx` dep; **not** exceljs). 3 sheets: Channel Summary (17 cols, ALL accounts incl. unassigned/dormant), Day-wise Breakdown (one row per link), About (window + caveats).
- `GET /admin/reports/export.xlsx` route (declared before `/:reportId`), binary download with Content-Disposition.
- `apiFetchBlob` + `downloadBlob` in `apps/internal/src/lib/api.ts`; `ExportButton` in `apps/internal/src/app/reports/_export.tsx`, wired into BOTH `/reports` and `/reports/links` headers, honoring the selected pill.

### Verification done
- 9/9 export aggregation unit tests + 22/22 daily-report tests (incl. firstSeenAt preservation) green.
- Full `npm run build` (all 5 apps) + tsc (api, shared, internal) clean.
- Live authenticated download through the running dev server: HTTP 200, correct MIME + filename, valid PK/xlsx, 3 sheets, real seeded data reconciles (3 channels incl. unassigned+dormant, IST avg time 15:00 from 10:00+20:00, casing collapsed, no NaN).
- The 36 pre-existing failures in analytics/content/task/team tests were confirmed identical with this work stashed — **not caused by this change** (setup.ts truncate-list gaps, unrelated).

### Styling pass (2026-06-03, follow-up)
The first cut looked like a raw data dump in Numbers/Excel (truncated headers, no color). Reworked the serialization layer:
- Added **`xlsx-js-style`** (free SheetJS community fork that writes cell styles; the plain `xlsx@0.18.5` community build silently drops `.s`). Imported via `require()` in `report-export.service.ts` (it ships no types).
- Styled output: **bold dark (`#1A1A1A`) header row, white text**, **zebra cream/white banding**, thin borders, **right-aligned numbers / centered status+platform**, per-column widths (no more truncated headers), autofilter dropdowns, and **unassigned channels tinted terracotta** with a bold "Unassigned" flag. About sheet has a 16pt bold title + wrapped muted notes.
- **Freeze-pane is NOT supported by the community writer** — dropped it (the bold dark header + autofilter carry the header instead). Don't re-add `!freeze`/`!panes`; it's silently ignored.
- Verified the *direct* buffer's `xl/styles.xml` (fills/fonts/cellXfs all present) and rendered a Quick Look thumbnail — styling confirmed. ⚠️ Don't verify styles by reading the file back with `XLSX.read(...,{cellStyles:true})` — `xlsx-js-style`'s **reader** mangles style shape on re-read even though the **written** file is correct. Inspect the raw XML or open in a real app instead.
- The pure `buildExportRows` aggregation was untouched; all 31 unit tests + full build still green. Opens correctly in Excel, Google Sheets, Numbers, LibreOffice (standard OOXML styling).

### Simplification pass (2026-06-03, follow-up 2)
Per user feedback the first styled version had too many/jargon-y columns. Changes:
- **Removed the "Client" column** and the entire **"About" sheet** → workbook is now exactly 2 sheets (Channel Summary, Day-wise Breakdown).
- **Plain-English headers** (no "window" jargon). Summary: Channel · Handle · Platform · Channel Status · **Assignment Status** · **Assigned To** · Contact · **Who Posted** · No. of People Who Posted · **Total Links** · **Links Today** · **Avg Links per Day** · **Avg Posting Time (IST)** · Report Submissions · Last Activity (IST) · Followers. Breakdown: Date · Posting Time (IST) · Channel · Handle · Platform · **Posted By** · **Link URL** · Likes · Comments · Views · Report Submitted At (IST) · Approx Time?.
- **Kept both employee columns** ("Assigned To" = who it's assigned to; "Who Posted" = who actually posted — these answer the user's "which individual is involved" question). Unassigned rows still tinted terracotta + bold "Unassigned" in the Assignment Status cell.
- The `buildReportsWorkbook(input, _generatedAt)` signature kept (generatedAt now unused after About removal) so tests/callers don't churn. `aboutSheet()` + the now-orphaned `TITLE` const removed.
- Verified: 9/9 export tests updated + green, tsc clean, live styled download rendered correctly (16 summary cols, 2 sheets).

### ⚠️ Operational lesson — don't `npm run build` while dev servers run
Running a full `npm run build` writes **production** `.next` artifacts over the **dev** server's `.next`, transiently breaking localhost:3000 (`Cannot find module './590.js'` / 500s on routes). It usually self-heals on the next request (file watcher recompiles), but once it left the dev process with a corrupted in-memory manifest and needed a restart. **For verification while dev servers are live, use `tsc --noEmit` per app instead of the full production build.** See [[incident-build-over-dev-next-cache]].

---

## 1. Understanding Summary

- **What:** An "Extract to Spreadsheet" button for admins on the Internal portal's `/reports` and `/reports/links` pages. Clicking it downloads a single `.xlsx` workbook with **two worksheets**: a **Channel Summary** sheet (one row per SocialAccount, including unassigned/zero-activity channels) and a **Day-wise Breakdown** sheet (one row per individual link — the raw ledger).
- **Why:** Admins need an offline, pivotable, audit-grade view of report/link activity per channel and per day. Data accuracy is the top priority and the export must be trustworthy at any point in time.
- **Who:** Internal-portal admins with `reports.view` permission (same gate as the existing reports endpoints).
- **Scope of data:** Honors the date-range pill currently selected on the page (`startDate`/`endDate`), consistent with the existing "everything follows the pill" convention. "Today's links" is always the literal current IST day regardless of window.
- **Non-goals:** No Google Sheets API integration. No prod deploy in this task. No charts inside the workbook. No scheduling/email of the export.

## 2. The central data-accuracy problem (and the fix)

`ReportLink` has **no surviving original-post timestamp**. Report submission is **delete-and-recreate**: on every resubmit the transaction does `reportLink.deleteMany` → `dailyReport.update({submittedAt: now})` → `reportLink.createMany`. So **every** link's `createdAt` is rewritten to the latest edit moment, and `submittedAt` is the last-touch time.

Consequence (confirmed with the user's own example): "2 links at 10:00 AM, then edit + 10 more at 8:30 PM" → after the edit, **all 12** rows show `createdAt ≈ 8:30 PM`. The 10:00 AM information is destroyed. Any "average posting time" built on `createdAt`/`submittedAt` is really "time of the last edit," and is link-count-distortable.

**Decision: capture true post time going forward via a schema change** (`ReportLink.firstSeenAt`) that is **preserved across resubmits per-URL**. See §4.

## 3. Decision Log

| # | Decision | Alternatives considered | Why |
|---|----------|------------------------|-----|
| D1 | Server-generated single `.xlsx`, two tabs, via **exceljs**, downloaded through `apiFetchRaw`/blob | Two CSVs; Google Sheets API | Multi-tab + formatting; opens in Excel & Google Sheets; matches existing server-artifact pattern (PDFs/AI HTML). CSV mangles URLs/leading-zeros; Sheets API needs OAuth infra we don't have. |
| D2 | Summary sheet = **one row per SocialAccount** (ALL of them, incl. zero-link & unassigned) | Only active channels | User explicitly wants unassigned channels visible; satisfies the spec directly. |
| D3 | Granular sheet = **one row per link** | per channel×day; per employee×day | True raw ledger — maximally accurate, pivotable. User chose this. |
| D4 | Summary "Employee" col = **assigned** employee(s) from `AccountAssignment` (active); separate "Employees Involved" col = everyone who actually posted | Top poster | Two different real questions, both in the spec. |
| D5 | **Add `ReportLink.firstSeenAt`**, preserved per-URL across resubmits; new URLs get `now()` | Use createdAt + warning; omit time; per-link createdAt avg | Only way to make posting-time truly accurate & future-proof. User chose schema change. |
| D6 | firstSeenAt = **original first-submit moment**, stays put across later edits of the same URL | Update to latest edit | Truthful per-link timeline; the whole point of D5. |
| D7 | Historical backfill: `firstSeenAt = createdAt` for existing rows | Leave NULL | Best available proxy, no nulls; export notes pre-deploy times are approximate. |
| D8 | Time metric = **per-link `firstSeenAt`** time-of-day, averaged per channel; also show **distinct-report submit time** so the count-distortion the user flagged is visible/avoidable | submittedAt only; both columns only | firstSeenAt now gives true per-link time, so per-link avg is finally honest. |
| D9 | Button on **both** `/reports` and `/reports/links` headers | one page only | User chose both. |
| D10 | All date math in **IST** via `todayIST`/`dateToIST`/`istMidnight` from `@dashmani/shared` | UTC like the existing `getAllAccountsLinkStats` | CLAUDE.md IST rule; the existing UTC code is a latent bug we won't replicate. |

## 4. Schema change — `ReportLink.firstSeenAt`

```prisma
model ReportLink {
  ...
  createdAt    DateTime  @default(now()) @map("created_at")
  firstSeenAt  DateTime  @default(now()) @map("first_seen_at")  // NEW
  ...
  @@index([accountId])
}
```

**Preserve-across-resubmit logic** in `submitDailyReport` (`daily-report.service.ts`), in the `existing` branch only:

1. **Before** the `$transaction`, load the current links for that report: `findMany({ where:{ reportId: existing.id }, select:{ url:true, firstSeenAt:true } })`.
2. Build `Map<normalizedUrl, firstSeenAt>`.
3. In `linkRows()`, for each link: `firstSeenAt = priorMap.get(url.trim().toLowerCase()) ?? new Date()`. Scheduled links / null-url links just use `now()`.
4. New report branch: all links `firstSeenAt = now()` (Prisma default — no code needed, but set explicitly for clarity).

**One-time backfill** (`packages/db/prisma/backfill-first-seen.ts`): `UPDATE report_links SET first_seen_at = created_at WHERE first_seen_at IS NULL` — but since the column has a `@default(now())`, `db:push` will stamp existing rows with the push moment. So the backfill script must run a raw `UPDATE report_links SET first_seen_at = created_at;` **once, right after `db:push`**, to reset them to the better `createdAt` proxy. Script is idempotent-safe to re-run (sets to createdAt every time). **Localhost only for now.**

⚠️ **`db:push` required locally** after schema edit (additive — ADD COLUMN only, safe). Per CLAUDE.md, never auto-run on prod; this task is localhost-only anyway.

## 5. API design

### New endpoint
`GET /admin/reports/export.xlsx?startDate=&endDate=` — `authenticate` + `requirePermission("reports","view")`. Returns `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` with `Content-Disposition: attachment; filename="reports-export-<start>_<end>.xlsx"`. Declared in `admin-reports.routes.ts` **before** the `/:reportId` catch-all (Express ordering rule from CLAUDE.md).

### New service: `apps/api/src/services/report-export.service.ts`
`buildReportsWorkbook(startDate?, endDate?): Promise<Buffer>`

**Data gathering (all IST):**
- `start`/`end` default to last 30 IST days if absent; parse via `istMidnight`.
- `accounts` = `socialAccount.findMany` with `platform`, and `assignments` filtered `unassignedAt:null` → `employee {id,name}`.
- `links` = `reportLink.findMany({ where:{ report:{ date:{ gte,lte } } }, select:{ id, url, platform, firstSeenAt, likes, comments, views, accountId, account:{handle,displayName,platform}, report:{ date, submittedAt, employeeId, employee:{id,name} } } })`.
- `todayLinks` = same but `report.date` = `istMidnight(todayIST())` (literal today), for the "Today's Links" column — computed independently of the window.
- `contact`: per assigned employee, pull `EmployeeProfile`/`User.phone`/`email`. (Contact = assigned employee's phone/email; if multiple, join.)

**Sheet 1 — "Channel Summary"** (one row per SocialAccount):

| Col | Source / computation |
|-----|----------------------|
| Page (Channel) | `account.displayName` |
| Handle | `account.handle` |
| Platform | `account.platform.name` |
| Channel Status | `account.status` (ACTIVE/PAUSED/ARCHIVED) via `formatStatus` |
| Assigned Employee(s) | active `AccountAssignment` employees, joined by `, ` — **blank if none** |
| Assigned? | "Unassigned" if no active assignment, else "Assigned" (so unassigned channels are filterable) |
| Contact | assigned employee phone/email (joined) |
| Employees Involved (posted) | distinct employees who posted links to this channel in window, joined |
| # Employees Involved | count of the above |
| Total Links (window) | count of window links for this account |
| Today's Links | count of today's links for this account |
| Avg Links/Day | totalLinks / activeDays-in-window (days the channel actually had ≥1 link; if 0 → 0). Also compute /calendarDays variant? **No** — one definition: total ÷ number of distinct IST days in window that had activity for this channel. Document it in a header note. |
| Avg Submit Time (IST) | mean time-of-day of `firstSeenAt` across this channel's window links, formatted `HH:MM`. Blank if 0 links. |
| Distinct Report Submits | count of distinct (employeeId,date) reports that touched this channel — lets admin see the count-distortion context |
| Last Activity (IST) | max `firstSeenAt` date+time in window |
| Followers | `account.followerCount` |
| Client | `account.clientName` |

Sorted: assigned-with-activity first by Total Links desc, then unassigned, then zero-activity — OR simpler: Total Links desc, then displayName. (Implementation: Total Links desc, then name asc; unassigned naturally sink if zero links but still present.)

**Sheet 2 — "Day-wise Breakdown"** (one row per link, sorted by date desc then channel then firstSeenAt):

| Col | Source |
|-----|--------|
| Date (IST) | `dateToIST(report.date)` |
| Submit Time (IST) | `firstSeenAt` time-of-day `HH:MM` |
| Channel | `account.displayName` |
| Handle | `account.handle` |
| Platform | `account.platform.name` (fallback `link.platform`, lowercased-normalized for display) |
| Employee (posted) | `report.employee.name` |
| URL | `link.url` (stored as text; exceljs cell type string to avoid Excel auto-linkifying/mangling) |
| Likes / Comments / Views | `link.likes/comments/views` (blank if null) |
| Report Submitted At (IST) | `report.submittedAt` full datetime |
| Approx? | "Yes (pre-2026-06-03)" if `firstSeenAt` was backfilled (i.e. equals createdAt and report.date < deploy date) — a simple heuristic flag so admins know which times are original vs approximate. Implementation: flag if `report.date` < the deploy date constant. |

**Top "Notes" rows / a 3rd tiny "About" sheet:** include window dates, generated-at IST timestamp, and a one-line caveat: "Submit times for links first submitted before 2026-06-03 reflect last-edit time, not original post time, due to a historical limitation. Times on/after that date are true first-submission times." Keep it minimal — a small "About" sheet is cleanest.

**Accuracy guarantees baked in:**
- All grouping keys use IST day strings (no UTC drift).
- Platform display normalized (lowercase-collapse the mixed-casing issue noted in CLAUDE.md) so "Instagram"/"instagram" don't double-count.
- Avg time skips channels with 0 links (no NaN).
- Numbers come from the same `reportLink` rows the on-screen pages use — no separate denormalized source to drift.

## 6. Frontend design

- New shared component `apps/internal/src/app/reports/_export.tsx` (`_`-prefixed so Next won't route it): `ExportButton({ startDate, endDate })`.
  - Calls a new `apiFetchBlob(path)` helper in `apps/internal/src/lib/api.ts` (mirrors `apiFetch` token + refresh handling but returns `res.blob()` and reads `Content-Disposition` for filename). Triggers download via a temporary `<a>` + object URL.
  - Loading state ("Extracting…"), disabled while in-flight, inline error text on failure.
- Wire into both page headers:
  - `/reports/page.tsx` header (next to "Links Analytics" button) — passes the page's current `startDate`/`endDate` derived from the active pill.
  - `/reports/links/page.tsx` header — same.
- Styling matches existing header buttons (cream/ink palette).

## 7. Dependencies

- Add **`exceljs`** to `apps/api/package.json` (`npm install exceljs -w @dashmani/api`). Pure JS, no native build — safe on the 2GB Linode later. ~Streaming writer keeps memory bounded for large exports.

## 8. Build sequence (TDD where it pays)

1. Schema: add `firstSeenAt`; `db:generate` + `db:push` (local); write + run `backfill-first-seen.ts` (local). 
2. `submitDailyReport`: preserve-across-resubmit logic. **Unit test** (Vitest) the firstSeenAt-preservation invariant: submit URL A at T1, resubmit with A+B at T2 → A.firstSeenAt==T1, B.firstSeenAt==T2.
3. `report-export.service.ts`: pure aggregation function returning a plain JS object (rows for both sheets) — **unit-test the aggregation** against a seeded fixture for: unassigned channel appears, zero-link channel appears, today vs window counts, IST grouping, platform-casing collapse, avg-time skips empty. Then a thin `toWorkbook(rows)` wrapper around exceljs (not unit-tested beyond a smoke "two sheets, headers present").
4. Route in `admin-reports.routes.ts` (before `/:reportId`).
5. `apiFetchBlob` + `ExportButton` + wire both headers.
6. Verify: `npm run build` (all apps) + `tsc --noEmit` on internal + api; manual download in browser on localhost; open the file; spot-check a channel's numbers against the on-screen page.

## 9. Risks / edge cases

- **Large exports:** one-row-per-link could be 10k+ rows. exceljs handles it; use the streaming workbook writer if memory is a concern. Window default (30d) bounds it; admin can narrow the pill.
- **Deleted/archived employees:** assigned/involved employees may be soft-deleted — still show their name (left-join), mark nothing special unless needed.
- **Links with null account / null url:** guard; skip null-account links from per-channel rollups (can't attribute), but they still appear in the granular sheet with blank channel.
- **firstSeenAt heuristic for "Approx?":** purely date-based flag; acceptable since exact backfill provenance isn't stored.
- **Mixed platform casing:** normalize on read for display & grouping.

## 10. Verification checklist (definition of done, localhost)

- [ ] `firstSeenAt` preserved across resubmit (unit test green).
- [ ] Aggregation unit tests green (unassigned, zero-link, today vs window, IST, casing, avg-time).
- [ ] `GET /admin/reports/export.xlsx` returns a valid 2-sheet workbook.
- [ ] Button on both pages; honors selected window; downloads named file.
- [ ] Numbers reconcile with on-screen Reports page for a sample channel.
- [ ] `npm run build` (all 5 apps) + tsc clean.
- [ ] No process killed on any port; nothing pushed to prod.