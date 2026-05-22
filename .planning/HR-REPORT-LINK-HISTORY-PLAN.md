# HR Report — "Today's Submitted Links" history panel

**Created:** 2026-05-22
**Scope:** `apps/hr` frontend only. **No API changes. No DB changes. No schema changes.**
**Sizing:** Small — single file edit, ~80–120 lines of JSX + helpers.
**Target executor:** Sonnet (medium thinking) — self-contained, no architectural decisions left to make.

---

## 1. Problem (from the user, 2026-05-22)

> "After individuals have pasted their links and submitted it, they should see which links were those that they had submitted for that day (a sort of history) as when they update their report to send more links on the HR portal, they tend to forget which was the last link they had submitted for that day."

Employees submit links throughout the day. They return later to add more. The form re-prefills with the currently-saved links, but visually it's mixed in with empty rows and editable fields — they can't easily tell at a glance "these 7 links I already saved this morning."

## 2. Solution shape (decided — do NOT redesign)

Add a **read-only "Submitted today" panel** at the top of the `/report` page, above the form. It shows the links that are currently saved in `existing` (the response from `useTodayReport()`). No API change. No new endpoint. No new state shape on the server. Purely a render of data we already fetch.

**Explicit non-goals:**
- ❌ Do NOT add a `submittedAt` per-link timestamp to the schema.
- ❌ Do NOT change `POST /hr/reports` from delete-and-recreate to upsert.
- ❌ Do NOT introduce a `ReportSubmission` snapshot table.
- ❌ Do NOT remove the form prefill behavior — the form continues to show the saved links so the user can edit/delete them.

**Why these constraints:** The HR daily-report flow is load-bearing for the org. The current `delete-and-recreate` semantics in [daily-report.service.ts:147-148](../apps/api/src/services/daily-report.service.ts) are well-tested and we don't change them. The history panel is purely a presentation-layer affordance over data we already have.

## 3. Where the data already comes from

- Hook: [apps/hr/src/lib/hooks/use-reports.ts:4-8](../apps/hr/src/lib/hooks/use-reports.ts) — `useTodayReport()` calls `GET /hr/reports/today`, refreshes every 60s.
- Response shape: `{ success, data: { id, date, notes, links: ReportLink[] } | null }`.
- Each `ReportLink` already includes: `id`, `url`, `description`, `accountId`, `likes`, `comments`, `shares`, `views`, `mediaUrl`, `isScheduled`, `scheduledFor`, `createdAt`, plus a Prisma-included `account` relation with `platformSlug`/`platform` and `name`.

The page already reads `existing` at [apps/hr/src/app/report/page.tsx:110-113](../apps/hr/src/app/report/page.tsx):
```tsx
const { data: todayData } = useTodayReport();
const existing = (todayData as any)?.data;
```

## 4. Implementation steps

### Step 1 — Add a `TodaySubmittedPanel` component inline in `report/page.tsx`

Define it inside the same file (no new file — it's used in exactly one place). Place the function above the default-exported page component.

```tsx
function TodaySubmittedPanel({ existing, accounts }: {
  existing: any;
  accounts: any[];
}) {
  if (!existing || !existing.links || existing.links.length === 0) return null;

  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const fmtTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    } catch {
      return "";
    }
  };

  return (
    <div className="bg-[#FAF7F0] border border-[#E8E0D0] rounded-2xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          <h3 className="text-sm font-medium text-[#1A1A1A]">
            Submitted today ({existing.links.length})
          </h3>
        </div>
        <span className="text-[11px] text-[#7A7A7A]">
          Last updated {fmtTime(existing.updatedAt || existing.createdAt)}
        </span>
      </div>
      <ul className="space-y-2 max-h-64 overflow-y-auto pr-1">
        {existing.links.map((l: any, i: number) => {
          const acc = accountById.get(l.accountId);
          const platform = (acc?.platformSlug || acc?.platform || "").toLowerCase();
          return (
            <li
              key={l.id || i}
              className="flex items-start gap-3 bg-white border border-[#E8E0D0] rounded-lg px-3 py-2"
            >
              <span className="text-[11px] font-mono text-[#7A7A7A] mt-0.5 min-w-[1.5rem]">
                {i + 1}.
              </span>
              <div className="flex-1 min-w-0">
                <a
                  href={l.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-[#1A1A1A] hover:text-[#B8960C] truncate block"
                >
                  {l.url}
                </a>
                <div className="flex items-center gap-2 mt-0.5 text-[11px] text-[#7A7A7A]">
                  {platform && <span className="capitalize">{platform}</span>}
                  {acc?.name && <span>· {acc.name}</span>}
                  {l.isScheduled && l.scheduledFor && (
                    <span className="inline-flex items-center gap-1 text-amber-700">
                      <Clock className="h-3 w-3" /> scheduled
                    </span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="text-[11px] text-[#7A7A7A]">
        These are the links currently saved for today. Edit them below — the form is pre-filled with the same list.
      </p>
    </div>
  );
}
```

### Step 2 — Render the panel in the page JSX

Insert it in the page's render tree at [apps/hr/src/app/report/page.tsx:309](../apps/hr/src/app/report/page.tsx), just **after** the header block (closing `</div>` of the header flex container around line 338) and **before** the warnings block (line 340).

The `accounts` array is already available — the page calls `useAssignedAccounts()`. Find the variable name it's destructured to (likely `accounts` or `accountsData?.data`). Pass it through.

```tsx
{/* Header */}
<div className="flex items-start justify-between">
  {/* ...existing header... */}
</div>

{/* NEW: read-only history panel */}
<TodaySubmittedPanel existing={existing} accounts={accounts || []} />

{/* Warnings */}
{duplicateUrls.length > 0 && (
  // ...
)}
```

### Step 3 — Verify the `accounts` variable name

Open the file and scan the top of the default-exported component for the `useAssignedAccounts()` call. Use whatever it destructures to. If it's `const { data: accountsData } = useAssignedAccounts();` then pass `accountsData?.data || []`. **Do not guess** — read the actual line.

### Step 4 — Defensive checks

- `existing` may be `null` (no report yet today) — the early `return null` handles that.
- `existing.links` may be missing — the `!existing.links` check handles that.
- `accounts` may be empty on first paint — the `Map` will just yield `undefined` for `accountById.get(...)`, and the conditional `acc?.name && ...` renders nothing. Safe.
- `existing.updatedAt` may be absent depending on Prisma include — falls back to `createdAt`, then to empty string via `try/catch` in `fmtTime`.

### Step 5 — Imports

`CheckCircle2` and `Clock` are already imported at [apps/hr/src/app/report/page.tsx:6-8](../apps/hr/src/app/report/page.tsx). No new imports needed.

## 5. Verification checklist (executor MUST run before declaring done)

1. **Type check passes:**
   ```bash
   npx tsc --noEmit -p apps/hr/tsconfig.json
   ```
2. **Build passes:**
   ```bash
   npm run build -w @dashmani/hr
   ```
3. **Manual smoke test:**
   - Start dev servers: `npm run dev`
   - Open `http://localhost:3002` → log in as an HR user who has at least one assigned account.
   - Navigate to `/report`.
   - If user has no report yet today: panel does not appear (correct).
   - Submit a report with 2–3 links → on next page load (or after the 60s SWR refresh, or after `mutate`), the panel appears at the top with those links + timestamp.
   - Refresh the page → panel persists.
   - Add 1 more link in the form, submit → panel updates to show 3–4 links.
   - Click a URL in the panel → opens in new tab (`target="_blank"` + `rel="noopener noreferrer"`).
4. **No regression in form behavior:** form still prefills with existing links, scheduled badges still render, submit/update button still toggles label.

## 6. Out-of-scope / explicitly NOT in this task

- Adding history for **prior days** (the panel is "today only"). Reports for prior days are immutable in current UX — that's a separate feature.
- Showing **deleted** links from earlier submissions. That requires a schema change we explicitly rejected.
- Adding any new API endpoint.
- Touching the API, the service layer, the DB, or any other portal.
- Internal portal admin views of employee submissions (already exists at `/reports/[employeeId]`).

## 7. Files touched

| File | Change |
|------|--------|
| `apps/hr/src/app/report/page.tsx` | Add `TodaySubmittedPanel` component (~70 lines) and render it once in JSX (~1 line) |

That's it. No other file should be modified.

## 8. Commit message template

```
feat(hr): show today's submitted links above the report form

When an employee returns to /report later in the day to add more links,
the new read-only "Submitted today" panel shows the links currently saved,
so they don't have to scroll through the editable form (or worse, guess
which links they already submitted earlier in the day).

Frontend-only. No API/DB changes — reads from existing
GET /hr/reports/today response.
```
