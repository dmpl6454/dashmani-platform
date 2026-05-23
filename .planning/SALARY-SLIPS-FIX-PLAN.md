# Salary Slips Fix Plan (2026-05-23)

**Audience:** Claude Sonnet-medium (no thinking). This plan is self-contained — every change is spelled out with exact file paths, line numbers, payload shapes, and copy. **Do not re-explore.** Read this file top-to-bottom, then execute.

---

## TL;DR — what's wrong, what we're shipping

| Issue | Root cause | Fix |
|---|---|---|
| 1. Internal `/salary-slips` table shows `—` in Basic and sometimes Employee Name columns | Frontend reads `slip.basic` and `slip.employeeName`; API returns `slip.basicSalary` and `slip.employee.name` | Rename fields in the page |
| 2. Search input on `/salary-slips` is dead | Backend `listSalarySlips()` ignores `search` param | Add `search` filter to service + route |
| 3. AI Assistant "Salary Slips" tab is a read-only viewer that duplicates the listing page and has no generator | The component was never built — only a viewer was wired | Replace `SalarySlipViewer` with a full `SalarySlipGenerator` that matches the Offer/Contract/Appointment pattern (form → AI preview → Send to Employee) |
| 4. No way to create a single salary slip from the UI | Only bulk-generate button exists; `POST /admin/salary-slips/generate` (single) is unwired | Wire it via the new AI Assistant generator above |
| 5. Admin can't edit values before approval | `/salary-slips` is approve/reject only | Add an Edit modal opened from a row "Edit" button, calling a new `PUT /admin/salary-slips/:id` endpoint |
| 6. HR portal employee view | Works fine | No change |

The dedicated `/salary-slips` page becomes the **approval queue + edit workflow**. The AI Assistant becomes the **creation tool** (like Offer/Contract/Appointment). This mirrors the pattern the user already accepted for offer/contract.

⚠️ **No `db:push` required.** No schema changes. Pure code.

---

## File map (everything you'll touch)

| Path | Change |
|---|---|
| [apps/api/src/services/salary-slip.service.ts](../apps/api/src/services/salary-slip.service.ts) | Add `search` filter; add `updateSalarySlip()` |
| [apps/api/src/routes/admin-features.routes.ts](../apps/api/src/routes/admin-features.routes.ts) | Add `search` query param; add `PUT /admin/salary-slips/:id`; add `POST /admin/ai/salary-slip/preview` |
| [apps/api/src/services/ai.service.ts](../apps/api/src/services/ai.service.ts) | Add `generateSalarySlipPreviewHtml()` that takes form data (not a saved slip ID) |
| [apps/internal/src/app/salary-slips/page.tsx](../apps/internal/src/app/salary-slips/page.tsx) | Fix field names; wire search; add Edit modal; add View HTML link |
| [apps/internal/src/app/ai-assistant/page.tsx](../apps/internal/src/app/ai-assistant/page.tsx) | Replace `SalarySlipViewer` with `SalarySlipGenerator` |

---

## Section 1 — API: add `search`, `updateSalarySlip`, and AI preview-from-form

### 1.1 [apps/api/src/services/salary-slip.service.ts](../apps/api/src/services/salary-slip.service.ts)

**(a)** Find the `ListSalarySlipsFilters` interface (just above `listSalarySlips`). Add an optional `search?: string` field.

**(b)** In `listSalarySlips()` (around line 227), add a Prisma `OR` clause when `filters.search` is present:

```ts
if (filters.search && filters.search.trim()) {
  const s = filters.search.trim();
  where.employee = {
    OR: [
      { name: { contains: s, mode: "insensitive" } },
      { email: { contains: s, mode: "insensitive" } },
    ],
  };
}
```

**(c)** Append a new exported function `updateSalarySlip` immediately after `rejectSalarySlip`:

```ts
export async function updateSalarySlip(
  id: string,
  data: {
    basicSalary?: number;
    hra?: number;
    conveyance?: number;
    medicalAllowance?: number;
    specialAllowance?: number;
    otherEarnings?: number;
    pf?: number;
    esi?: number;
    tax?: number;
    otherDeductions?: number;
    remarks?: string;
  }
) {
  const existing = await prisma.salarySlip.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, "NOT_FOUND", "Salary slip not found");
  if (existing.status === "APPROVED")
    throw new AppError(400, "ALREADY_APPROVED", "Cannot edit an approved salary slip");

  const merged = { ...existing, ...data };
  const totalEarnings =
    (merged.basicSalary || 0) +
    (merged.hra || 0) +
    (merged.conveyance || 0) +
    (merged.medicalAllowance || 0) +
    (merged.specialAllowance || 0) +
    (merged.otherEarnings || 0);
  const totalDeductions =
    (merged.pf || 0) + (merged.esi || 0) + (merged.tax || 0) + (merged.otherDeductions || 0);
  const netSalary = totalEarnings - totalDeductions;

  return prisma.salarySlip.update({
    where: { id },
    data: { ...data, netSalary },
    include: { employee: { select: { id: true, name: true, email: true } } },
  });
}
```

### 1.2 [apps/api/src/services/ai.service.ts](../apps/api/src/services/ai.service.ts)

Find `generateSalarySlipHtml(salarySlipId: string)` (~line 182). Add a sibling export `generateSalarySlipPreviewHtml` that takes the same shape as the AI-assistant form. Reuse the existing template logic — easiest is to extract the HTML construction inside `generateSalarySlipHtml` into a helper that both functions call. If the existing HTML is built inline, just duplicate it for now (the user said "no thinking", so don't refactor — copy is fine, document with a one-line comment).

Function signature:
```ts
export async function generateSalarySlipPreviewHtml(input: {
  employeeId: string;
  month: number;
  year: number;
  basicSalary: number;
  hra: number;
  conveyance: number;
  medicalAllowance: number;
  specialAllowance: number;
  otherEarnings: number;
  pf: number;
  esi: number;
  tax: number;
  otherDeductions: number;
  remarks?: string;
}): Promise<{ html: string; employeeName: string; netSalary: number }>
```

Body: fetch the employee `{ id, name, email, profile: { designation, joinDate } }`, compute `netSalary` the same way as `updateSalarySlip` above, then render the same HTML template `generateSalarySlipHtml` uses (replace `slip.basicSalary`-style reads with the corresponding form fields).

### 1.3 [apps/api/src/routes/admin-features.routes.ts](../apps/api/src/routes/admin-features.routes.ts)

**(a)** Find `GET /admin/salary-slips` (~line 74). Extend the query parsing to include `search`:

```ts
const { employeeId, month, year, status, search } = req.query as Record<string, string | undefined>;
const slips = await salarySlipService.listSalarySlips({
  employeeId,
  month: month ? parseInt(month) : undefined,
  year: year ? parseInt(year) : undefined,
  status,
  search,
});
```

**(b)** Add a new route `PUT /admin/salary-slips/:id` (place right before the existing `POST /:id/approve` route at ~line 115). Same auth + permissions:

```ts
adminFeaturesRouter.put(
  "/salary-slips/:id",
  authenticate,
  requirePermission("employees", "edit"),
  validateBody(updateSalarySlipSchema),
  async (req, res, next) => {
    try {
      const updated = await salarySlipService.updateSalarySlip(req.params.id, req.body);
      res.json({ success: true, data: updated });
    } catch (e) {
      next(e);
    }
  }
);
```

Define `updateSalarySlipSchema` near the top of the file (alongside other Zod schemas):

```ts
const updateSalarySlipSchema = z.object({
  basicSalary: z.number().nonnegative().optional(),
  hra: z.number().nonnegative().optional(),
  conveyance: z.number().nonnegative().optional(),
  medicalAllowance: z.number().nonnegative().optional(),
  specialAllowance: z.number().nonnegative().optional(),
  otherEarnings: z.number().nonnegative().optional(),
  pf: z.number().nonnegative().optional(),
  esi: z.number().nonnegative().optional(),
  tax: z.number().nonnegative().optional(),
  otherDeductions: z.number().nonnegative().optional(),
  remarks: safeString.optional(),
});
```

If `safeString` isn't already imported, add: `import { safeString } from "@dashmani/shared";`.

**(c)** Add `POST /admin/ai/salary-slip/preview` next to the existing `GET /admin/ai/salary-slip/:id/html` (~line 743):

```ts
adminFeaturesRouter.post(
  "/ai/salary-slip/preview",
  authenticate,
  requirePermission("employees", "view"),
  validateBody(salarySlipPreviewSchema),
  async (req, res, next) => {
    try {
      const result = await aiService.generateSalarySlipPreviewHtml(req.body);
      res.json({ success: true, data: result });
    } catch (e) {
      next(e);
    }
  }
);
```

`salarySlipPreviewSchema`:
```ts
const salarySlipPreviewSchema = z.object({
  employeeId: z.string().uuid(),
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2020).max(2100),
  basicSalary: z.number().nonnegative(),
  hra: z.number().nonnegative(),
  conveyance: z.number().nonnegative(),
  medicalAllowance: z.number().nonnegative(),
  specialAllowance: z.number().nonnegative(),
  otherEarnings: z.number().nonnegative(),
  pf: z.number().nonnegative(),
  esi: z.number().nonnegative(),
  tax: z.number().nonnegative(),
  otherDeductions: z.number().nonnegative(),
  remarks: safeString.optional(),
});
```

---

## Section 2 — Frontend: fix the dedicated page

[apps/internal/src/app/salary-slips/page.tsx](../apps/internal/src/app/salary-slips/page.tsx)

### 2.1 Fix field names

In the table body (~lines 158–163), change:
- `slip.employeeName || slip.employee?.name || "—"` → `slip.employee?.name || "—"` (the `employeeName` fallback is bogus; the service never returns it)
- `slip.basic != null ? `₹${...}` : "—"` → use `slip.basicSalary` (rename `basic` → `basicSalary` in both the conditional and the value)

### 2.2 Add Edit + View action buttons

Inside the Actions cell (~line 169), regardless of status:
- Add a **View** button (small, neutral) that opens `{API_URL}/admin/ai/salary-slip/${slip.id}/html` in a new tab. Use `process.env.NEXT_PUBLIC_API_URL` like the AI Assistant viewer does.
- Add an **Edit** button (icon: `Pencil` from `lucide-react`) that sets `editSlip` state to this row. Hide Edit when `status === "APPROVED"` (backend rejects it anyway).
- Keep the existing Approve/Reject buttons unchanged.

### 2.3 Build an Edit modal

Add inline in the same page file (not a separate file — match the pattern of small modals elsewhere in the app):

State: `const [editSlip, setEditSlip] = useState<any>(null);`

When `editSlip` is set, render a fixed-position overlay with a centered card containing a form pre-filled with the slip's existing values. All 11 numeric fields (basicSalary, hra, conveyance, medicalAllowance, specialAllowance, otherEarnings, pf, esi, tax, otherDeductions) plus a remarks textarea. A live "Net Salary" computed display (sum of earnings − sum of deductions). Two buttons: **Cancel** (closes the modal) and **Save** (calls `PUT /admin/salary-slips/${editSlip.id}` with the changed fields, then `mutate()` + close modal).

On save error, set an inline `editError` state and render it in red inside the modal — **do not use `alert()`** (matches the inline-banner convention applied across the internal portal on 2026-05-23).

### 2.4 Wire search to backend

The `search` param is already being passed in the URL (line 35). After the service change in §1.1(b) the existing code starts working. No frontend change needed — but **debounce** the input so we don't fire a request per keystroke:

Replace the `value={search}` input with a 250 ms debounced version. Easiest: introduce `searchInput` state for the field value and `search` state for the debounced value; sync via `useEffect(() => { const t = setTimeout(() => setSearch(searchInput), 250); return () => clearTimeout(t); }, [searchInput])`.

---

## Section 3 — Frontend: replace AI Assistant viewer with a generator

[apps/internal/src/app/ai-assistant/page.tsx](../apps/internal/src/app/ai-assistant/page.tsx)

**Delete** the existing `SalarySlipViewer` component (currently at lines ~471–514) and replace with `SalarySlipGenerator` modelled exactly on `AppointmentGenerator` (lines ~277–373). Where the generator tab is rendered in the parent (search the file for `<SalarySlipViewer`), swap the JSX to `<SalarySlipGenerator employees={employees} loading={loading} setLoading={setLoading} result={result} setResult={setResult} openHtml={openHtml} />`.

### 3.1 SalarySlipGenerator shape

Form state:
```ts
const [form, setForm] = useState({
  employeeId: "",
  month: String(new Date().getMonth() + 1),
  year: String(new Date().getFullYear()),
  basicSalary: "",
  hra: "",
  conveyance: "",
  medicalAllowance: "",
  specialAllowance: "",
  otherEarnings: "0",
  pf: "",
  esi: "",
  tax: "0",
  otherDeductions: "0",
  remarks: "",
});
```

### 3.2 Auto-prefill on employee select

When `employeeId` changes, look up `employees.find(e => e.id === id)` and if `emp.profile?.salary` exists, compute a standard breakdown and populate the empty fields. Use this rule of thumb (already what `generateBulkSalarySlips` uses in `salary-slip.service.ts` — match it for consistency):

- `basicSalary = salary * 0.5`
- `hra = salary * 0.2`
- `conveyance = salary * 0.05`
- `medicalAllowance = salary * 0.05`
- `specialAllowance = salary * 0.2` (gross of allowances)
- `pf = basicSalary * 0.12`
- `esi = salary < 21000 ? salary * 0.0075 : 0`
- `tax = 0`

(Check `generateBulkSalarySlips` in `apps/api/src/services/salary-slip.service.ts` — if the constants differ, **copy from there**, don't hardcode in the frontend.)

### 3.3 Generate (preview)

```ts
async function generate() {
  if (!form.employeeId || !form.basicSalary) return alert("Select employee and fill basic salary");
  setLoading(true);
  setResult(null);
  setSentAt(null);
  try {
    const res = await apiFetch<any>("/admin/ai/salary-slip/preview", {
      method: "POST",
      body: JSON.stringify({
        employeeId: form.employeeId,
        month: parseInt(form.month),
        year: parseInt(form.year),
        basicSalary: parseFloat(form.basicSalary || "0"),
        hra: parseFloat(form.hra || "0"),
        conveyance: parseFloat(form.conveyance || "0"),
        medicalAllowance: parseFloat(form.medicalAllowance || "0"),
        specialAllowance: parseFloat(form.specialAllowance || "0"),
        otherEarnings: parseFloat(form.otherEarnings || "0"),
        pf: parseFloat(form.pf || "0"),
        esi: parseFloat(form.esi || "0"),
        tax: parseFloat(form.tax || "0"),
        otherDeductions: parseFloat(form.otherDeductions || "0"),
        remarks: form.remarks || undefined,
      }),
    });
    setResult(res.data); // { html, employeeName, netSalary }
  } catch (e: any) { alert(e.message); }
  finally { setLoading(false); }
}
```

### 3.4 Send to Employee

```ts
async function sendToEmployee() {
  if (!form.employeeId || !form.basicSalary) return;
  setSaving(true);
  try {
    await apiFetch<any>("/admin/salary-slips/generate", {
      method: "POST",
      body: JSON.stringify({
        employeeId: form.employeeId,
        month: parseInt(form.month),
        year: parseInt(form.year),
        basicSalary: parseFloat(form.basicSalary || "0"),
        hra: parseFloat(form.hra || "0"),
        conveyance: parseFloat(form.conveyance || "0"),
        medicalAllowance: parseFloat(form.medicalAllowance || "0"),
        specialAllowance: parseFloat(form.specialAllowance || "0"),
        otherEarnings: parseFloat(form.otherEarnings || "0"),
        pf: parseFloat(form.pf || "0"),
        esi: parseFloat(form.esi || "0"),
        tax: parseFloat(form.tax || "0"),
        otherDeductions: parseFloat(form.otherDeductions || "0"),
        remarks: form.remarks || undefined,
      }),
    });
    setSentAt(new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }));
  } catch (e: any) { alert(e.message); }
  finally { setSaving(false); }
}
```

### 3.5 JSX layout

Copy `AppointmentGenerator`'s JSX verbatim and swap:
- Heading: "Generate Salary Slip"
- Subtext: "AI-styled salary slip — preview, then send to the employee. They'll see it in the HR portal under 'Salary Slips'."
- Form fields: replace appointment fields with the salary slip fields (employee, month select, year select, then 4 columns of earnings inputs, 4 columns of deductions inputs, remarks textarea). Numeric `input type="number" step="0.01"` for the money fields.
- Amber warning banner: "Preview only — click **Send to Employee** to save this salary slip. It will appear in /salary-slips for approval and in the employee's HR portal." (only show when `!sentAt`)
- Open & Print button stays.

⚠️ The `POST /admin/salary-slips/generate` endpoint **fails with 409 if a slip already exists for `(employeeId, month, year)`** because of the unique constraint. Catch this case: if `e.message` contains `Unique constraint`, surface: "A salary slip for this employee and month already exists. Edit it from the /salary-slips page instead."

---

## Section 4 — Verification

Before declaring done:

1. **TypeScript**: `npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/internal/tsconfig.json` — both pass.
2. **Build**: `npm run build` (all apps) — passes.
3. **Manual sanity**:
   - Start `npm run dev`.
   - Log in to internal portal as admin.
   - Go to **AI Assistant → Salary Slips** tab. Pick an employee with `profile.salary` set. Confirm fields auto-prefill. Click **Generate** — HTML preview renders in the iframe. Click **Send to Employee** — confirmation chip appears.
   - Go to **/salary-slips**. New slip appears in the table for current month. Confirm **Basic** column shows a number (not `—`). Click **Edit** — modal opens with values pre-filled. Change `hra` by 100. Save. Modal closes. Table reflects new net salary.
   - Type a partial employee name in the search box. List narrows after ~250ms.
   - Approve the slip. Status pill flips to "Approved". Edit button disappears for that row.
   - Open HR portal (port 3002), log in as that same employee. **/salary-slips** shows the slip. Click **Download** — print window opens with formatted slip.

---

## Why this flow is "better" (answer to user's question)

The user asked: "do you have a better flow?" — yes, and this is it.

- **One creation path, not two.** The AI Assistant becomes the single seamless place to *create* a salary slip (matches Offer/Contract/Appointment muscle memory). The `/salary-slips` page becomes the single place to *review, edit, approve, and bulk-generate*. No more duplicated viewer.
- **Bulk-generate stays** because it's the monthly use case (push button → 50 employees get slips).
- **AI Assistant generator** is the one-off use case (need a slip for one person, want to tweak values before saving).
- **Edit-before-approve** closes the "values are wrong, what now?" trap that didn't have a UI answer before.
- **HR portal stays untouched** — it already works.

---

## Out of scope (do not do)

- ❌ Don't change the `SalarySlip` schema. No `db:push`.
- ❌ Don't add a delete endpoint for salary slips. APPROVED slips are immutable financial records.
- ❌ Don't refactor `generateBulkSalarySlips` — it's load-bearing and the percentages are tuned for org payroll.
- ❌ Don't migrate `alert()` calls in the AI Assistant page to inline banners as part of this task — that's a separate sweep. The Edit modal in `/salary-slips` should use inline banners (it's a new component, fresh start), but the AI Assistant generators all still use `alert()` for parity with sibling generators.

---

## Files touched (final list for the commit)

```
apps/api/src/services/salary-slip.service.ts
apps/api/src/services/ai.service.ts
apps/api/src/routes/admin-features.routes.ts
apps/internal/src/app/salary-slips/page.tsx
apps/internal/src/app/ai-assistant/page.tsx
```

5 files. No DB migration. ~300 LOC across all changes.
