# Client Portal — Implementation Plan

**Scope:** Close all feature gaps in `apps/client`, wire real API data, and deliver consistent UI across every page.
**Branch convention:** work off `main`; one PR per phase.

---

## Audit Summary

### What already works (do not touch)
- Login page + auth flow (`/login`, `layout.tsx`, `lib/auth.ts`, `lib/api.ts`)
- Dashboard stats + activity feed (`dashboard/page.tsx`)
- Projects list with filters, sort, health bar (`projects/page.tsx`)
- Project detail — social accounts, tasks, approvals, files (`projects/[id]/page.tsx`)
- Content list view with format/aspect pills, status filters, project filter (`content/page.tsx`)
- Content detail with IG previews, approval actions, keyboard shortcuts, discussion thread (`content/[id]/page.tsx`)
- Approvals split-view inbox, all keyboard shortcuts, multi-select, bulk actions (`approvals/page.tsx`)
- Component library: `portal-shared`, `portal-rail`, `portal-topstrip`, `portal-shell`, `ig-previews`, `reason-modal`, `portal-icons`
- Tailwind token layer (`tailwind.config.ts`)

### Gaps to close (this plan)
| # | Gap | Effort |
|---|-----|--------|
| G1 | Client self-signup (no register endpoint or page) | M |
| G2 | ContentPost schema missing `format`, `aspectRatio`, `hashtags` | S |
| G3 | No `PostComment` model — discussion thread is mock-only | M |
| G4 | `Project` has no `healthScore` field in DB | S |
| G5 | Content calendar view — toggle exists, no calendar grid | M |
| G6 | Analytics page — placeholder only | M |
| G7 | Files page — placeholder only | S |
| G8 | All pages use mock `portal-store` data, not real API | L |
| G9 | `Actions.reply()` in portal-store is not wired to API | S |
| G10 | No `loading.tsx` / `error.tsx` in any route | S |
| G11 | UI consistency — analytics + files pages inconsistent with shell | S |

---

## Phase 1 — DB Schema Extension

**Goal:** Add missing fields and models so subsequent phases have a real DB backing.

**Files to edit:**
- `packages/db/prisma/schema.prisma`

**Tasks:**

### 1a — Extend `ContentPost`
Add three fields to the `ContentPost` model:
```prisma
format      String?   // e.g. "REEL" | "CAROUSEL" | "STORY" | "POST" | "DOC"
aspectRatio String?   @map("aspect_ratio")  // e.g. "9:16" | "4:5" | "1:1"
hashtags    String[]  @default([])
```

### 1b — Extend `Project`
Add health score field:
```prisma
healthScore Int?  @map("health_score")  // 0-100, null = not yet calculated
```

### 1c — Add `PostComment` model
Insert after `ContentPost`:
```prisma
model PostComment {
  id        String      @id @default(uuid())
  postId    String      @map("post_id")
  authorId  String      @map("author_id")
  body      String      @db.Text
  createdAt DateTime    @default(now())

  post      ContentPost @relation(fields: [postId], references: [id], onDelete: Cascade)
  author    User        @relation("CommentAuthor", fields: [authorId], references: [id])
}
```
Add the reverse relation on `ContentPost`:
```prisma
comments  PostComment[]
```
Add the reverse relation on `User`:
```prisma
postComments PostComment[] @relation("CommentAuthor")
```

### 1d — Add `ClientInvite` model (for signup flow)
```prisma
model ClientInvite {
  id        String   @id @default(uuid())
  email     String   @unique
  token     String   @unique @default(uuid())
  expiresAt DateTime @map("expires_at")
  usedAt    DateTime? @map("used_at")
  createdAt DateTime @default(now())
}
```

**After editing schema:**
```bash
npm run db:generate
npm run db:push
```

**Verification:**
- `prisma studio` shows new fields on `ContentPost`, `Project`, `PostComment`, `ClientInvite` tables
- `npx tsc --noEmit -w packages/db` passes with no errors

---

## Phase 2 — API: Client Signup + Comments + Files + Analytics

**Goal:** Add four missing API capabilities before wiring the frontend.

### 2a — Client self-signup (invite-based)

**New validator** — `packages/shared/src/validators/client.ts`, add:
```typescript
export const clientRegisterSchema = z.object({
  token:    z.string().uuid("Invalid invite token"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  contactName: z.string().min(2).max(200).optional(),
});
```

**New service methods** — `apps/api/src/services/client-auth.service.ts`:
- `createInvite(email: string): Promise<ClientInvite>` — creates a `ClientInvite` row, returns token
- `acceptInvite(token: string, password: string, contactName?: string): Promise<{ accessToken, refreshToken, user }>` — validates token not expired/used, hashes password, creates `Client` row, marks invite used, returns JWT

**New endpoints** — `apps/api/src/routes/client.routes.ts`:
```
POST /v1/client/auth/invite-request   body: { email }               → createInvite
POST /v1/client/auth/register         body: { token, password, contactName? } → acceptInvite
```
`/invite-request` must be protected by `authenticate` + `requirePermission("clients","create")` (admin-only).
`/register` is public (no auth middleware).

### 2b — Post comments endpoint

**New service** — `apps/api/src/services/content.service.ts` (extend existing):
- `getPostComments(postId, clientId)` — verify client owns post's project, return comments with author name
- `addPostComment(postId, authorId, body)` — insert `PostComment` row

**New endpoints** — `apps/api/src/routes/client.routes.ts`:
```
GET  /v1/client/content/:id/comments   → getPostComments
POST /v1/client/content/:id/comments   body: { body: string } → addPostComment
```
Both protected by `authenticateClient`.

### 2c — Client files endpoint

**New service** — `apps/api/src/services/client.service.ts` (extend):
- `getClientFiles(clientId, { projectId?, search? })` — join `ProjectFile` through `Project.clientId = clientId`

**New endpoint:**
```
GET /v1/client/files?projectId=&search=   → getClientFiles
```
Returns: `{ id, name, url, size, mimeType, createdAt, project: { id, name } }[]`

### 2d — Client analytics endpoint

Check `apps/api/src/routes/analytics.routes.ts` and `apps/api/src/services/analytics.service.ts`. 
If no client-scoped analytics path exists, add:
```
GET /v1/client/analytics   → getClientAnalytics(clientId)
```
Returns:
```typescript
{
  totalPosts: number,
  postsByStatus: Record<ContentStatus, number>,
  postsByFormat: Record<string, number>,
  approvalTurnaround: number,   // avg hours PENDING→APPROVED in last 30d
  scheduledThisWeek: number,
  liveThisWeek: number,
  projectSummaries: { projectId, name, healthScore, postCount, pendingCount }[]
}
```

**Verification:**
```bash
# Compile check
npx tsc --noEmit -w apps/api

# Smoke test each new endpoint with curl / Postman
POST /v1/client/auth/register        { token: "<valid-invite-token>", password: "test1234" }
GET  /v1/client/content/:id/comments
POST /v1/client/content/:id/comments { body: "Looks great" }
GET  /v1/client/files
GET  /v1/client/analytics
```

---

## Phase 3 — Frontend: Signup Flow

**Goal:** Add `/signup` page so invited clients can set their password and log in.

**Files to create/edit:**
- `apps/client/src/app/signup/page.tsx` (new)
- `apps/client/src/app/login/page.tsx` (add "Have an invite?" link)
- `apps/client/src/app/layout.tsx` (allow `/signup` route without auth redirect)

### 3a — Signup page (`/signup`)

URL pattern: `/signup?token=<uuid>`

UI (match login page style exactly — same gradient background, same card):
1. If no `token` query param → show "Invalid or expired invite link" empty state with back-to-login link
2. If token present → show form: Contact name (optional), Password, Confirm password
3. On submit → `POST /v1/client/auth/register` with `{ token, password, contactName }`
4. On success → store tokens + user in localStorage (same keys as login: `clientAccessToken`, `clientRefreshToken`, `clientUser`) → redirect to `/dashboard`
5. On error → show inline error (token expired, already used, etc.)

### 3b — Login page link

Add below the submit button:
```tsx
<p className="text-sm text-ink-3 text-center">
  Have an invite? <Link href="/signup" className="text-ink-2 underline underline-offset-2">Set up your account</Link>
</p>
```

### 3c — Layout auth guard

In `layout.tsx`, extend the bypass list:
```typescript
const publicRoutes = ["/login", "/signup"];
if (!token && !publicRoutes.includes(pathname)) router.push("/login");
```

**Verification:**
- Visit `/signup?token=bad` → see error state
- Visit `/signup?token=<valid>` → complete form → land on dashboard → localStorage keys set
- Visit `/login` → "Have an invite?" link visible

---

## Phase 4 — Frontend: Content Calendar View

**Goal:** Replace the placeholder calendar toggle with a real month-grid calendar.

**File:** `apps/client/src/app/content/page.tsx`
**New component:** `apps/client/src/components/content-calendar.tsx`

### 4a — `ContentCalendar` component

Props:
```typescript
interface ContentCalendarProps {
  year: number;
  month: number;           // 1-indexed
  posts: Post[];
  onPostClick: (postId: string) => void;
  onMonthChange: (year: number, month: number) => void;
}
```

Render:
- Month header: `< April 2025 >` with prev/next chevron buttons (use `Icon.ChevLeft` / `Icon.ChevRight`)
- 7-column header row: Sun Mon Tue Wed Thu Fri Sat (use `text-ink-4 text-xs` styling)
- Day cells: 5–6 rows of 7 cells; days outside month shown as muted (`text-ink-4`)
- Each day cell that has posts: stack up to 3 `FormatPill` badges (reuse from `portal-shared.tsx`); if more than 3, show `+N` chip
- Today highlighted with `bg-action-soft rounded-full` on the date number
- Post click → call `onPostClick(post.id)` → navigate to `/content/${post.id}`
- Use `useClientContentCalendar(year, month, projectFilter)` SWR hook (already exists at `lib/hooks/use-content.ts`)

Styling rules (match existing portal style):
- Cell border: `border border-rule`
- Cell background: `bg-surface` (selected day: `bg-muted`)
- Week rows: `divide-y divide-rule`
- Minimum cell height: `min-h-[88px]`

### 4b — Wire calendar into content page

In `content/page.tsx`:
- Add state: `const [calYear, setCalYear] = useState(new Date().getFullYear())`  
  `const [calMonth, setCalMonth] = useState(new Date().getMonth() + 1)`
- Replace placeholder calendar `<div>` with `<ContentCalendar year={calYear} month={calMonth} posts={filteredPosts} onPostClick={...} onMonthChange={...} />`

**Verification:**
- Toggle to calendar → month grid renders with correct days
- Posts appear as `FormatPill` stacks on their scheduled dates
- Prev/Next month navigation works
- Click a post pill → navigates to `/content/${id}`

---

## Phase 5 — Frontend: Analytics Page

**Goal:** Replace placeholder with real charts using the client analytics API.

**File:** `apps/client/src/app/analytics/page.tsx`
**Dependency to add:** `recharts` (lightweight, no extra peer deps)

```bash
npm install recharts -w @dashmani/client
```

### 5a — Page layout

Use `Topstrip` with `title="Analytics"`.

Four stat cards row (reuse `StatCard` from `@dashmani/ui`):
| Label | Value |
|---|---|
| Posts live this week | `liveThisWeek` |
| Scheduled this week | `scheduledThisWeek` |
| Avg approval time | `approvalTurnaround` hrs |
| Total posts | `totalPosts` |

### 5b — Charts section

**Posts by status** — `PieChart` (recharts) with slices for each `ContentStatus`
- Colors: use `danger.DEFAULT` for REJECTED, `success.DEFAULT` for PUBLISHED/APPROVED, `action.DEFAULT` for SCHEDULED, `neutral.DEFAULT` for DRAFT, `attention.DEFAULT` for PENDING_APPROVAL

**Posts by format** — `BarChart` (recharts) — formats on x-axis, count on y-axis
- Bar fill: `action.DEFAULT`

**Project summaries table** — one row per project:
`Project name | Health bar | Posts | Pending`
- Reuse the health bar pattern from `projects/page.tsx` (copy the inline width + color logic)

### 5c — Data fetching

Use `useClientAnalytics()` hook (already exists at `lib/hooks/use-analytics.ts`).
Show `<Skeleton />` rows while loading (add `Skeleton` to `portal-shared.tsx` — a `div` with `animate-pulse bg-muted rounded`).

**Verification:**
- Page renders without errors
- Stat cards show real numbers from API
- Both charts render with correct data
- Project table shows all client projects

---

## Phase 6 — Frontend: Files Page

**Goal:** Replace placeholder with a real files browser aggregated across all projects.

**File:** `apps/client/src/app/files/page.tsx`
**New SWR hook:** `apps/client/src/lib/hooks/use-files.ts`

### 6a — SWR hook

```typescript
// lib/hooks/use-files.ts
export function useClientFiles(projectId?: string, search?: string) {
  const params = new URLSearchParams();
  if (projectId) params.set("projectId", projectId);
  if (search) params.set("search", search);
  return useSWR<ClientFile[]>(`/client/files?${params}`, fetcher);
}
```

### 6b — Page layout

Use `Topstrip` with `title="Files"` and `projectFilter` prop wired to a project dropdown (same pattern as content page).

Table with columns: File icon (derive from `mimeType`), File name, Project badge, Size, Uploaded date, Download link.

Derive icon from mimeType:
- `image/*` → `Icon.File` (use a variant if available, else generic)
- `video/*` → same
- `application/pdf` → same
- default → `Icon.File`

File size: format bytes → `12 KB`, `1.4 MB` (helper: `formatBytes(n)`).
Download: `<a href={file.url} target="_blank" download>` with a small `Icon.ArrowRight` styled as a subtle link.

Empty state: `<Empty icon={Icon.File} title="No files yet" hint="Files uploaded to your projects appear here." />`

**Verification:**
- Page renders file list when project has files
- Project filter dropdown narrows results
- Download link opens file in new tab
- Empty state shown when no files

---

## Phase 7 — Frontend: Wire Real API (Replace Mock Store)

**Goal:** Replace all `usePortalStore(sel.*)` calls with real SWR data; keep mock store only for offline/dev fallback.

### Strategy
Pages currently import from `lib/portal-store`. Replace each page's data source with SWR hooks. Keep the mock store file but stop importing `sel.*` from it in page code.

### 7a — Dashboard page (`dashboard/page.tsx`)

Replace:
```typescript
// BEFORE
const projects = usePortalStore(sel.projects);
const posts = usePortalStore(sel.posts);
const activity = usePortalStore(sel.activity);
```
With:
```typescript
// AFTER
const { data: projects } = useClientProjects();
const { data: analyticsData } = useClientAnalytics();
// derive stats from analyticsData
```
Activity feed: add `GET /v1/client/activity` endpoint returning last-12h events, OR derive from recent approvals/comments. Use `useClientAnalytics` data for stats.

### 7b — Projects page (`projects/page.tsx`)

Replace `usePortalStore(sel.projects)` with `useClientProjects({ status, search })`.
Map API `ProjectStatus` (ACTIVE/PAUSED/COMPLETED/ARCHIVED) to display tokens (Active/Paused/Done/Archived).

### 7c — Project detail page (`projects/[id]/page.tsx`)

Already uses `useClientProject(id)` SWR hook — verify it actually loads and renders correctly. Fix any field name mismatches between API response and UI expectations.

### 7d — Content page (`content/page.tsx`)

Replace `usePortalStore(sel.posts)` with `useClientContent({ projectId, status, search })`.
Map API `ContentStatus` enum values to the filter chip labels:
- `PENDING_APPROVAL` → "Needs you"
- `APPROVED` → "Approved"
- `SCHEDULED` → "Approved" (show scheduled date)
- `PUBLISHED` → "Live"
- `REJECTED` → "Revision / Rejected"

Add `overdue` derived field: `scheduledAt && scheduledAt < now() && status === "SCHEDULED"`.

### 7e — Content detail page (`content/[id]/page.tsx`)

Replace `usePortalStore(sel.postById(id))` with `useClientContentPost(id)`.
Replace `usePortalStore(sel.pending)` (queue) with `useClientContent({ status: "PENDING_APPROVAL" })` for queue navigation.
Wire `Actions.approve / revise / reject` to `PUT /v1/client/content/:id/respond` (already exists) and mutate SWR cache after.

### 7f — Approvals page (`approvals/page.tsx`)

Replace `usePortalStore(sel.pending)` with `useClientApprovals({ status: "PENDING" })`.
Wire approve/revise/reject actions to `PUT /v1/client/approvals/:id/respond`.

### 7g — Discussion thread

Replace `Actions.reply()` mock with:
```typescript
async function sendReply(postId: string, body: string) {
  await apiFetch(`/client/content/${postId}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
  mutate(`/client/content/${postId}/comments`); // SWR revalidate
}
```
Fetch thread on mount: `useClientPostComments(postId)` using the comments endpoint from Phase 2b.

**Verification for each sub-task:**
- Real data appears (not mock names like "Tabish", "Alex")
- Approve/revise/reject actions persist after page refresh
- Queue navigation advances through real pending posts

---

## Phase 8 — Frontend: Loading, Error & Empty States

**Goal:** Every route must handle loading and error gracefully — no blank screens.

**Files to create (one per route group):**

### 8a — Route-level loading skeletons
Create `loading.tsx` in each route folder:

Pattern (same skeleton structure for all pages):
```tsx
// apps/client/src/app/dashboard/loading.tsx
export default function Loading() {
  return (
    <div className="p-6 space-y-4">
      <div className="h-8 w-48 bg-muted rounded animate-pulse" />
      <div className="grid grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-24 bg-muted rounded-lg animate-pulse" />
        ))}
      </div>
      <div className="h-64 bg-muted rounded-lg animate-pulse" />
    </div>
  );
}
```
Create this for: `dashboard/`, `projects/`, `projects/[id]/`, `content/`, `content/[id]/`, `approvals/`, `analytics/`, `files/`

### 8b — SWR error handling
In each page that uses SWR:
```typescript
const { data, error, isLoading } = useSomeHook();
if (isLoading) return <PageSkeleton />;    // inline skeleton
if (error)    return <PageError />;         // see below
```

Add `PageError` to `portal-shared.tsx`:
```tsx
export function PageError({ message = "Something went wrong" }: { message?: string }) {
  return (
    <Empty
      icon={Icon.AlertTriangle}
      title="Could not load"
      hint={message}
    />
  );
}
```

**Verification:**
- Throttle network in DevTools → loading skeletons appear
- Kill API server → error state appears (not blank screen)

---

## Phase 9 — UI Consistency Audit

**Goal:** Ensure every page uses the same token layer, component patterns, and layout shell.

### 9a — Checklist per page
For each page (`dashboard`, `projects`, `projects/[id]`, `content`, `content/[id]`, `approvals`, `analytics`, `files`):
- [ ] Wrapped in `<Topstrip title="..." />` with correct `title` and optional `sub`
- [ ] No inline `style={{}}` attributes — all colors via Tailwind tokens
- [ ] No hardcoded hex colors (`#FDF6E3`, `#F5D547`, etc.) — use `bg-bg`, `text-action`, etc.
- [ ] Status badges use `<StatusBadge />` from `portal-shared.tsx` — not custom `<span>` with inline color
- [ ] Buttons use `<Button variant="..." />` — not custom `<button className="bg-...">`
- [ ] Empty states use `<Empty />` from `portal-shared.tsx`
- [ ] Loading states use `animate-pulse bg-muted rounded` skeleton pattern

### 9b — Global CSS cleanup
`apps/client/src/app/globals.css`:
- Ensure `body` background is `var(--tw-bg)` or hardcoded `#FDF6E3` (matching `bg-bg` token) — not a gradient
- Remove any duplicate color declarations that shadow the Tailwind config

### 9c — Topstrip consistency
Confirm `Topstrip` is imported and used on every non-login page. Pages that currently render their own header `<h1>` should replace it with `<Topstrip title="..." />`.

---

## Execution Order

```
Phase 1  → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6 → Phase 7 → Phase 8 → Phase 9
(schema)   (API)     (signup)   (cal)      (analytics) (files)  (API wire)  (states)  (audit)
```

Phases 4, 5, 6 can run in parallel after Phase 2 is done.
Phase 7 sub-tasks (7a–7g) can run in parallel within Phase 7.
Phase 8 and 9 are always last.

---

## Key File Reference

| Concern | File |
|---|---|
| DB schema | `packages/db/prisma/schema.prisma` |
| Client validators | `packages/shared/src/validators/client.ts` |
| Client auth service | `apps/api/src/services/client-auth.service.ts` |
| Client routes | `apps/api/src/routes/client.routes.ts` |
| Client auth middleware | `apps/api/src/middleware/client-auth.ts` |
| SWR hooks | `apps/client/src/lib/hooks/` |
| Mock store (phase out) | `apps/client/src/lib/portal-store.ts` |
| Shared UI components | `apps/client/src/components/portal-shared.tsx` |
| Auth context | `apps/client/src/lib/auth.ts` |
| API HTTP client | `apps/client/src/lib/api.ts` |
| Tailwind tokens | `apps/client/tailwind.config.ts` |
