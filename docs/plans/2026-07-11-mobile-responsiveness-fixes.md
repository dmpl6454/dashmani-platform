# Internal Portal — Mobile Responsiveness Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task (implementer → spec review → code-quality review per task), same as the CEO-dashboard PR that precedes it on this branch.

**Goal:** Fix three confirmed mobile-responsiveness bugs on the internal portal (`portal.digitalsukoon.com` / `apps/internal`), reported via QA doc "admin portal new.docx", verified live against the real code with root causes pinned.

**Architecture:** **Frontend-only. No backend, no new hooks, no `db:push`, no API-contract change.** All three are pure CSS/layout fixes to existing pages. Every fix is page-local — **do NOT touch the shared `@dashmani/ui` `Input` component** (its `h-11` is load-bearing across all 4 portals; changing it there would ripple everywhere).

**Branch:** Add to the existing `feat/ceo-dashboard-redesign` (already holds the CEO dashboard redesign + api-costs toggle fix, all unpushed). One PR for all internal-portal UI polish. Do NOT push until the user approves the whole branch.

**Tech Stack:** Next.js App Router (client components), Tailwind (custom tokens: `ink`, `indigo`, `terra`, `sage`, `attention`, `v3-card`, etc.), styled-jsx (login page uses `<style jsx global>` for its auth CSS), lucide-react.

**Verification bar for every task:** `npx tsc --noEmit -p apps/internal/tsconfig.json` clean + live browser check at **390px (mobile), 834px (tablet), 1440px (desktop)** via Playwright MCP. Dev servers already run (API :4000, internal :3000; login `tabish@dashmani.com` / `admin@123`). Screenshot each breakpoint. **The bug is a MOBILE bug — mobile (390px) verification is the acceptance gate, not optional.**

---

## Confirmed root causes (from live read-only investigation, 2026-07-11)

| # | Reported | Verified root cause | Legit? |
|---|----------|---------------------|--------|
| 1 | Login: email icon at bottom-left, should be centered | `.auth-field-icon` uses `top:50%;translateY(-50%)` centered on the **wrapper** (`.auth-field-wrap`), which for the email field ALSO contains the hint `<p>` ("Use your @digitalsukoon.com…"). Only the email field has a hint, so only its icon drifts below the input's center; mobile line-wrapping of the hint amplifies the drift. Password field is unaffected (no hint; its right icon uses a fixed `top-[22px]`). | ✅ Yes |
| 2 | Create New Project: date capsules collapsed | `grid grid-cols-2` never stacks on mobile → each `<input type="date">` squeezed to ~150px on a ~375px phone. Combined with the shared `Input`'s fixed `h-11` + `py-2.5` and no `min-w-0` on the grid children, the native iOS date widget can't lay out and collapses into a thin capsule. Text inputs are fine (no native widget). | ✅ Yes |
| 3 | Link reports: leaderboard rankings don't load on mobile | **Rankings DO load and render** (no fetch failure, no stuck spinner, no `hidden` breakpoint). The 5 ranking `<table>`s sit inside `overflow-x-auto`; on a phone the wide Employee column (~265px) eats most of the ~351px card, pushing Links/Avg/Streak/Best/Engagement off-screen with **no swipe affordance** → user sees only Rank + Employee and reads it as "rankings didn't load." | ✅ Yes (discoverability, not data) |

**Decisions locked with user (2026-07-11):**
- Issue 3 fix = **mobile card layout** (stacked label:value mini-cards below `sm`), applied to **all 5 leaderboard boards**, eliminating horizontal scroll entirely. (Not the lighter "scroll affordance only" option.)
- All three land on **`feat/ceo-dashboard-redesign`** (same branch/PR as the dashboard work).

---

## Task 1: Fix login email-icon vertical centering

**File:** `apps/internal/src/app/login/page.tsx` (single file; the CSS is in its `<style jsx global>` block)

**Root cause recap:** `.auth-field-icon` (line ~712) is `position:absolute; left:14px; top:50%; transform:translateY(-50%)`. It centers against `.auth-field-wrap` (line ~689, `position:relative`), which for the email field includes the in-flow hint `<p>` (line ~389-391) and any error `<p>` (line ~385-388). That makes the wrapper taller than the input, so `top:50%` lands below the input's own center. The password field's right-side control instead uses a fixed `top-[22px]` (lines ~374/380), which is immune — that's the proven pattern to mirror.

**The input geometry** (line ~694): `padding: 22px 42px 8px 42px`, single-line, `line-height:1.2` — a fixed-height control, so a fixed `top` offset lands mid-input reliably.

**Step 1 — Reproduce.** Load `http://localhost:3000/login` in Playwright at 390px width. Confirm the email field's mail icon sits low (toward the input's bottom edge / in the gap above the hint) while the password field's lock icon is centered. Screenshot. Bonus: type an invalid email and blur to trigger the error `<p>`, confirm the drift worsens (extra in-flow content → taller wrapper).

**Step 2 — Fix.** Change `.auth-field-icon` from wrapper-center positioning to a fixed input-relative offset, mirroring the eye/success button's proven scheme:
- FROM: `top: 50%; transform: translateY(-50%);`
- TO: `top: 22px; transform: none;`
(Keep `left:14px`, color, transition, `pointer-events:none`.) The `22px` matches the right-side icons' `top-[22px]`; verify against the actual input padding so the mail + lock icons both land on the input's text baseline row. If `22px` is slightly off visually, nudge to match the input's true vertical center (the input's content starts at `padding-top:22px`; the icon is `h-` a fixed size, so center it on the ~first-line row — fine-tune by eye in the browser).

**Step 3 — Verify.** At 390px: mail icon and lock icon both vertically centered in their inputs. Force the hint to wrap two lines (narrow enough) — icon stays put. Trigger the email error state — icon stays put. Re-check at 834px and 1440px (must not regress the desktop, where it currently looks OK-ish). Confirm the floating-label animation and the eye-toggle still work. Screenshot all three widths.

**Step 4 — Commit** (do NOT push): `fix(login): center email field icon (was anchored to wrapper incl. hint, drifted low on mobile)` + `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

**Guardrails:** Only touch the `.auth-field-icon` rule. Do NOT restructure the auth-field JSX (option 2 from the investigation — adding an inner wrapper — is more churn and not needed). Do NOT change `packages/ui`. The login page is the first surface every user hits — a broken build here locks everyone out, so the tsc + build gate is non-negotiable.

---

## Task 2: Fix Create-New-Project date fields collapsing on mobile

**File:** `apps/internal/src/app/projects/new/page.tsx` (single file)

**Root cause recap:** The Start/End Date row (lines ~66-69) is `grid grid-cols-2 gap-4` with **no responsive stacking**, so each date field gets ~150px on a phone. The shared `@dashmani/ui` `Input` (`packages/ui/src/components/input.tsx:12-23`) renders the `<input>` with a fixed `h-11` + `px-4 py-2.5` and no `min-w-0`; a native iOS `<input type="date">` widget can't lay out in that cramped, fixed-height box and collapses into a thin capsule. (Plain text inputs in the same form are fine — no native widget.)

**Step 1 — Reproduce.** Load `http://localhost:3000/projects/new` in Playwright at 390px. Confirm the Start/End date fields render as squished/tiny capsules side-by-side while Project Name / Description look fine. Screenshot. (Note: full native-iOS-Safari date-widget clipping is hard to reproduce in desktop-Chrome Playwright emulation; the ~150px cramped 2-col layout IS reproducible and is the primary visible defect. Verify the layout squeeze at minimum; call out that the true iOS widget behavior should be confirmed on a real device or iOS simulator if available.)

**Step 2 — Fix (page-local only, do NOT touch `packages/ui`):**
- (a) Stack on mobile: change the container `grid grid-cols-2 gap-4` → `grid grid-cols-1 sm:grid-cols-2 gap-4`. Each date field gets the full row width below `sm`.
- (b) Release the grid-item min-width floor + let the native widget set its own height, via the `className` prop on BOTH date `<Input>`s (the page `className` is appended after the base string in `cn(...)`, so trailing utilities win): add `min-w-0` and relax the fixed height for date inputs (`h-auto` will override the base `h-11` via later-declaration precedence). Keep the existing border/focus classes.
- Result target: on mobile each date field is full-width, tall enough for the native picker, no capsule collapse; on `sm+` they sit two-up as before.

**Step 3 — Verify.** At 390px: two date fields stacked, each full-width, tappable, native date picker opens and is usable, no capsule. At 834px + 1440px: still two-up, unchanged from today, no regression. Fill both dates, confirm the `min` constraint on End Date (`min={form.startDate}`) still works and the form submits. Screenshot all three widths.

**Step 4 — Commit** (do NOT push): `fix(projects): stack + un-collapse date fields on mobile (Create New Project)` + `Co-Authored-By` trailer.

**Guardrails:** Only `apps/internal/src/app/projects/new/page.tsx`. Do NOT modify `packages/ui/src/components/input.tsx` (ripples to all 4 portals). The client portal has NO create-project form (confirmed — its projects pages are read-only), so no parallel fix needed there. **Informational (not in scope for this task):** the same `grid-cols-2` + `<Input type="date">` pattern exists in `apps/internal/src/app/reports/_range.tsx` and (before Task 3) `reports/leaderboard/page.tsx` custom date pickers — flagged for a possible future sweep, NOT fixed here unless it naturally falls out of Task 3's leaderboard work.

---

## Task 3: Leaderboard mobile card layout (rankings readable without horizontal scroll)

**File:** `apps/internal/src/app/reports/leaderboard/page.tsx` (single file)

**Root cause recap:** All 5 ranking tables render correctly but their metric columns are off-screen inside `overflow-x-auto` on mobile, with no swipe affordance — reads as "rankings don't load." **Decision: replace the wide table with a stacked mini-card layout below the `sm` breakpoint**, so every metric is visible without horizontal scrolling. The `<table>` stays for `sm+` (desktop/tablet unchanged).

**The 5 boards (all get the treatment):**
1. Main **Rankings** table (lines ~146-218) — cols: Rank, Employee (name+email), Reports, Links, Avg/Report, Streak, Best Streak, Engagement.
2. **Total Collected Engagement** / top-links-leaderboard (part of lines ~220-335).
3-5. **YouTube / Facebook / Instagram** platform boards (lines ~337-413).

Read the file in full first to get each board's exact columns and the shared row-rendering shape (avatars, medals for top-3, name+email, the metric cells). Note the coverage note + stat cards (`grid-cols-2 md:grid-cols-4`, line ~122) are already mobile-fine — leave them.

**Step 1 — Reproduce.** Because local DB is empty (all leaderboard endpoints return `[]`), the page shows "No data found." locally. To verify the RENDER path you must inject realistic rows. Options: (a) use Playwright to intercept/mock the 4 SWR endpoint responses with sample data, or (b) seed a few `DailyReport`/link rows into the LOCAL dev DB only (never prod). Either way, at 390px confirm the current table shows only Rank + Employee with metrics off-screen (screenshot the "before"). Endpoints: `/admin/reports/leaderboard`, `/admin/reports/top-links-leaderboard`, `/admin/reports/platform-leaderboards`, `/admin/reports/leaderboard-coverage`.

**Step 2 — Build the responsive split.** For each of the 5 boards, implement a **dual render**: keep the existing `<table className="hidden sm:table w-full text-sm">` (add `hidden sm:table` so the table only shows at `sm+`), and add a **mobile-only** `<div className="sm:hidden space-y-2">` (or `block sm:hidden`) that maps the same data array into stacked mini-cards. Each mini-card:
- Top row: rank number/medal + employee name (full, allowed to wrap or truncate gracefully) + email on a second line (`text-xs text-ink-4`, `break-all` or `truncate` so a long email can't overflow).
- Metric rows: each metric as a `label: value` pair (e.g. "Reports 42 · Links 318" grouped, or one per line — pick the cleaner reading; keep it compact), using the SAME `fmtCompact`/number formatting the table cells already use (reuse the page's existing formatters — do NOT reimplement).
- Style the card with the existing card vocabulary (`v3-card`-ish / a light bordered `rounded-xl p-3` block matching this page's aesthetic — check what the page already uses for its containers and match it; do NOT introduce new arbitrary hex colors — this page currently uses a mix of hex literals like `#E8E0D0`, so match the page's OWN existing palette, don't invent).
- Preserve the top-3 medal treatment and any per-rank highlighting the table has.
- **DRY:** all 5 boards render the same "ranked list" shape. Strongly prefer extracting ONE small reusable mini-card row component (or a render helper) used by all 5, rather than copy-pasting the card markup 5×. If the 5 boards have genuinely different column sets (e.g. platform boards show different metrics than the main board), parameterize the metric rows (pass an array of `{label, value}` per board) rather than 5 bespoke blocks. Keep it simple; match the existing file's style.

**Step 3 — Preserve all existing behavior.** Loading state ("Loading…"), empty state ("No data found." / "No engagement data yet…"), the coverage note, the stat cards, the window/date pickers, and the desktop table must all be unchanged at `sm+`. The mobile cards read from the SAME SWR data — no new fetch, no new hook, no endpoint change. Confirm the `overflow-x-hidden` on the app shell `<main>` (layout.tsx:132) still prevents any page-level horizontal scroll.

**Step 4 — Verify (this is the acceptance gate).** With injected/seeded data:
- **390px:** each board renders as stacked mini-cards, EVERY metric visible without any horizontal scroll (`document.scrollWidth === clientWidth`, no per-card overflow). Top-3 medals present. Long employee emails don't overflow. Screenshot each of the 5 boards.
- **834px + 1440px:** the original tables render exactly as before (mobile cards hidden), no regression. Screenshot.
- Confirm no JS errors in console at any width. Confirm loading + empty states still work (temporarily clear the injected data).

**Step 5 — Commit** (do NOT push): `fix(leaderboard): stacked mobile card layout so rankings/metrics are readable on phones` + `Co-Authored-By` trailer.

**Guardrails:** Only `apps/internal/src/app/reports/leaderboard/page.tsx`. No backend/hook/db changes. Match the page's own existing palette + card style (don't import dashboard tokens or invent colors). If Task 2's date-field pattern (`grid-cols-2` + `<Input type="date">`) is present in this page's custom date picker and is trivially fixable in the same pass with the same one-line change, you MAY apply it here too (note it in the commit); otherwise leave it.

---

## Task 4: Full-branch verification (regression + responsive acceptance)

**No code changes expected** (verification only; fix minimally + report loudly if something is found).

**Step 1 — tsc:** `npx tsc --noEmit -p apps/internal/tsconfig.json` clean.

**Step 2 — Full monorepo build:** `npm run build` — ALL 5 apps must pass (a shared-component pull-in can break the production build even when dev + isolated tsc are green). Report the full result.

**Step 3 — Responsive click-through at 390 / 834 / 1440px** of the three fixed pages (`/login`, `/projects/new`, `/reports/leaderboard`) AND a quick regression pass of the pages the earlier commits on this branch touched (`/dashboard`, `/api-costs`) to confirm nothing on this branch regressed. For each: no horizontal page overflow, no overlap/clipping, fixes hold. Screenshot the three fixed pages at mobile width for the record.

**Step 4 — Confirm the earlier branch work is intact:** the CEO dashboard (Broadcast pill gone, collapsible More metrics, Account Growth/Top Movers, Top Performers/Top Links, 3 quick-nav cards removed) and the api-costs enrichment toggle fix all still render correctly.

**Step 5 — Report** PASS/FAIL per gate. This branch is the deliverable pending the user's final review; do NOT push or open the PR until the user says so.

---

## Non-goals / guardrails (whole plan)
- **Frontend-only. No backend, no new hooks, no `db:push`, no API-contract change.** If any fix seems to need backend work, STOP and flag it — it would change the PR's risk profile.
- **Never touch `packages/ui/src/components/input.tsx`** — its `h-11` is shared across all 4 portals; date-field fixes stay page-local via `className` overrides.
- **Don't redesign** — these are targeted mobile bug-fixes. Desktop (`sm+`) must look identical to today on all three pages.
- **Match each page's OWN existing style/palette** (login uses styled-jsx auth CSS; leaderboard uses hex literals like `#E8E0D0`; projects uses the shared `Input`). Don't cross-pollinate tokens or invent colors.
- **Mobile (390px) verification is the acceptance gate** for all three — they are mobile bugs. Verify on a real iOS device/simulator if available for the date-widget (Task 2), since desktop-Chrome emulation can't fully reproduce native iOS date-input behavior.
- All commits stay on `feat/ceo-dashboard-redesign`, unpushed, until the user approves.
