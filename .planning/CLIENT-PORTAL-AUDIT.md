# Client Portal — End-to-End Audit & Remediation Plan

**Date:** 2026-05-14  
**Last updated:** 2026-05-15  
**Branch:** `docs/design-critique`
**Scope:** `apps/client` + `apps/api` (client endpoints only)
**Status:** All 12 issues resolved across Waves 0–5. See commit log for details.

> Companion file: [CLIENT-PORTAL-ERRORS.md](./CLIENT-PORTAL-ERRORS.md) — all errors moved to Resolved section.

---

## TL;DR (post-fix)

All five waves landed. The portal is now functionally complete: data binding is correct, approvals are wired to the right model, the sidebar badge reads from the API, Ctrl+K opens a real command palette, "+ New Brief" is implemented end-to-end, the static notification bell is removed, and mock data no longer leaks into production paths.

---

## Original TL;DR (kept for historical context)

The client portal was structurally complete but functionally broken because of three systemic issues, plus several missing-feature issues:

1. **Two SWR hooks (`useClientAnalytics`, `useClientFiles`) do not unwrap the `{success, data}` envelope** returned by `apiFetch`. They are typed as the inner shape but receive the outer envelope, so every consumer reads `undefined`. → Analytics shows the "no data yet" empty state, Files shows "0 files" and a never-loading list.
2. **`GET /v1/client/approvals` returns `Approval` records, not `ContentPost` records**, but every consumer (`/approvals`, `/dashboard`) is written against the `ContentPost` shape **and** then calls `PUT /v1/client/content/:approvalId/respond` using the wrong ID type. → Approvals page silently breaks even when the inbox is populated.
3. **The Approvals sidebar badge reads from the seed mock store** (`portal-store.ts`), not from any real API. The seed file ships 10 mock posts with status `PENDING`; 7 of them are `PENDING` once you exclude the ones flipped to other statuses → that is the "7" the user sees.

On top of those, several header controls are decorative placeholders with no handlers (`Ctrl+K`, the search button, the notifications bell), and **there is no "+ New Brief" button anywhere in the codebase** — that flow was never implemented.

---

## Verified facts (read directly from source)

| Claim | Evidence |
|---|---|
| `apiFetch` returns the full `{success, data, meta?}` envelope (does NOT unwrap `.data`). | [apps/client/src/lib/api.ts:28](../apps/client/src/lib/api.ts#L28) — `return data;` after `await res.json()`. |
| `success(res, payload)` always wraps as `{success: true, data: payload}`. | [apps/api/src/utils/response.ts:4-7](../apps/api/src/utils/response.ts#L4-L7) |
| `useClientAnalytics` types as `ClientAnalytics` (the inner shape). | [apps/client/src/lib/hooks/use-analytics.ts:20-23](../apps/client/src/lib/hooks/use-analytics.ts#L20-L23) |
| `useClientFiles` types as `ClientFile[]` (the inner shape) and casts the fetch result to it. | [apps/client/src/lib/hooks/use-files.ts:20-23](../apps/client/src/lib/hooks/use-files.ts#L20-L23) |
| Analytics page reads `data.totalPosts` directly. With current `apiFetch`, this is always `undefined` (real value lives at `data.data.totalPosts`). | [apps/client/src/app/analytics/page.tsx:74](../apps/client/src/app/analytics/page.tsx#L74), [:89-97](../apps/client/src/app/analytics/page.tsx#L89-L97) |
| Files page reads `data.length` directly. With current `apiFetch`, this is `undefined` on the envelope. | [apps/client/src/app/files/page.tsx:36](../apps/client/src/app/files/page.tsx#L36), [:115](../apps/client/src/app/files/page.tsx#L115) |
| Dashboard, Approvals, Content, Projects pages all already unwrap correctly with `(raw as any)?.data ?? []`. | [dashboard/page.tsx:51-53](../apps/client/src/app/dashboard/page.tsx#L51-L53), [approvals/page.tsx:17-20](../apps/client/src/app/approvals/page.tsx#L17-L20), [content/page.tsx:19-20](../apps/client/src/app/content/page.tsx#L19-L20). The inconsistency is the bug — pick one convention. |
| `GET /v1/client/approvals` calls `approvalService.listApprovals` which queries `prisma.approval.findMany`. | [client.routes.ts:80-91](../apps/api/src/routes/client.routes.ts#L80-L91), [approval.service.ts:30-54](../apps/api/src/services/approval.service.ts#L30-L54) |
| Approval rows have fields `title, description, fileUrl, requestedBy, project, status, clientNote, respondedAt` — NOT `format, aspectRatio, scheduledAt, caption, hashtags, authorName, thread`. | [approval.service.ts:36-45](../apps/api/src/services/approval.service.ts#L36-L45) |
| Approvals page expects `post.format`, `post.aspectRatio`, `post.scheduledAt`, `post.caption`, `post.hashtags`, `post.authorName`, `post.thread/comments`. | [approvals/page.tsx:265-271](../apps/client/src/app/approvals/page.tsx#L265-L271), [:289-318](../apps/client/src/app/approvals/page.tsx#L289-L318) |
| Approvals page calls `PUT /client/content/:id/respond` using `approval.id`. `respondToContentApproval` looks up a `ContentPost` by that id → 404. | [approvals/page.tsx:45-72](../apps/client/src/app/approvals/page.tsx#L45-L72), [client.routes.ts:153-159](../apps/api/src/routes/client.routes.ts#L153-L159), [content.service.ts:179-203](../apps/api/src/services/content.service.ts#L179-L203) |
| Sidebar badge reads from mock store. | [portal-rail.tsx:25](../apps/client/src/components/portal-rail.tsx#L25) — `usePortalStore((s) => s.posts.filter((p) => p.status === "PENDING").length)` |
| The mock store ships with `PENDING` posts on first load and is never reset. | [portal-store.ts:88-100](../apps/client/src/lib/portal-store.ts#L88-L100) |
| Search button has no `onClick`. | [portal-topstrip.tsx:42-46](../apps/client/src/components/portal-topstrip.tsx#L42-L46) |
| Notifications bell has no `onClick` and the red dot is a static span. | [portal-topstrip.tsx:48-50](../apps/client/src/components/portal-topstrip.tsx#L48-L50) |
| No "+ New Brief" entry point exists. `grep -ri "new brief"` in `apps/client/src/` returns nothing. | Grep across the client app. |
| Approvals hook does not pass `?status=PENDING` — it asks for all approvals. | [use-projects.ts:16-21](../apps/client/src/lib/hooks/use-projects.ts#L16-L21) |
| `tsconfig.tsbuildinfo` is modified and `apps/api/src/services/client.service.ts` is untracked. | `git status` at audit time. |
| `nul` is an accidentally-committed file in repo root (likely a Windows `> nul` redirection mistake). | `git status` — `?? nul`. |

---

## Issue Register

### Severity legend
- **P0 — Blocker:** Feature is unreachable or visibly broken to the user.
- **P1 — High:** Feature appears to work but produces wrong results, or visibly inert control.
- **P2 — Medium:** Cosmetic, confusing, or silently swallows errors.
- **P3 — Cleanup:** Tech debt / cruft.

---

### ISSUE 1 — Analytics page shows nothing (P0)

**Symptom:** `/analytics` renders the "No data yet" empty state regardless of how much data exists.

**Root cause:** `useClientAnalytics` is typed as `ClientAnalytics` but `apiFetch` returns `{success, data: ClientAnalytics}`. Line 74 in `analytics/page.tsx`:

```ts
if (data && data.totalPosts === 0) { … return <Empty/> }
```

`data.totalPosts` is `undefined` (not `0`), so this check fails, falls through to line 89 destructure which sets every field to a default of `0` / `{}` / `[]`. The page renders, but `totalPosts === 0` is only checked once (line 74) **against the wrong field**. Actually `undefined === 0` is `false`, so the page actually falls through and renders zeros everywhere — that visually looks like "no data".

**Fix:** One of:
- **(A)** Change the hook to unwrap: `useSWR<ClientAnalytics>("/client/analytics", async (url) => (await apiFetch<{data: ClientAnalytics}>(url)).data, …)`
- **(B)** Change the page to read `data?.data?.totalPosts` etc. (consistent with dashboard/approvals/content/projects pages).

**Recommendation:** **(A)** at the hook layer. It's the smaller diff and gives correct TypeScript. Then update the page destructure to use `data` directly without `.data`.

**Files:**
- [apps/client/src/lib/hooks/use-analytics.ts:20-23](../apps/client/src/lib/hooks/use-analytics.ts#L20-L23)
- [apps/client/src/app/analytics/page.tsx:74, 89-97](../apps/client/src/app/analytics/page.tsx#L74)

---

### ISSUE 2 — Files page shows "0 files" and never lists anything (P0)

**Symptom:** Toolbar reads `0 files`. Empty state never resolves to rows even when uploads exist.

**Root cause:** Same envelope issue as Analytics. `useClientFiles` returns the full envelope but is typed as `ClientFile[]`. Page does:
- `${data.length} files` → `undefined`
- `data && data.length > 0 && data.map(...)` → never truthy
- `data && data.length === 0` → never truthy either → **the empty state never renders**, so the user sees a header with no content and assumes the page is broken.

**Fix:** Unwrap in the hook (recommendation A above) so `data: ClientFile[]` is honored.

**Files:**
- [apps/client/src/lib/hooks/use-files.ts:20-23](../apps/client/src/lib/hooks/use-files.ts#L20-L23)
- [apps/client/src/app/files/page.tsx:30, 36, 115, 167](../apps/client/src/app/files/page.tsx#L30)

---

### ISSUE 3 — Approvals inbox is wired to the wrong resource (P0)

**Symptom:** Approvals page renders rows that are missing thumbnails, format pills, captions, scheduled times, and discussion. Approve / Revise / Reject buttons either appear to do nothing or surface a "Could not approve" toast (404 from the API).

**Root cause:** `/v1/client/approvals` returns rows from the **legacy `Approval` model** (separate model — has `title`, `description`, `fileUrl`, `requestedBy`, `clientNote`, etc.), but the client portal's domain model is **`ContentPost`** (has `format`, `aspectRatio`, `caption`, `hashtags`, `scheduledAt`, `authorName`, `thread/comments`).

The approvals page is the wrong consumer. It needs `ContentPost` records with `status = "PENDING_APPROVAL"`, not `Approval` records.

Additionally, the page calls `PUT /v1/client/content/:id/respond` using the **approval's** id, but `respondToContentApproval` looks up that id as a `ContentPost.id` → 404.

**Fix (decision required from product):**
- **Option A (recommended) — Repoint Approvals page at content posts:**
  - Add a `clientId` filter (already present) and a `status = "PENDING_APPROVAL"` filter to a new endpoint or query parameter on `GET /v1/client/content`. Hook becomes `useClientContent({ status: "PENDING_APPROVAL" })` — *already supported by the existing endpoint!*
  - Change `useClientApprovals` in `use-projects.ts` to call `/client/content?status=PENDING_APPROVAL&limit=100`.
  - Approve/Revise/Reject already point at `/client/content/:id/respond` — those calls become correct once `id` is a real `ContentPost.id`.
  - Decide what happens to the legacy `Approval` model and `/client/approvals` endpoint (keep for admin; mark internal).
- **Option B — Keep the Approval model and rewrite the page:** much larger surface area; the page's IG previews, captions, hashtags, threads have no equivalent on the `Approval` model.

**Recommendation:** **Option A.** The existing schema, content service, and `respondToContentApproval` are all already aligned with the page's expectations — the only mistake is which endpoint feeds it.

**Files:**
- [apps/client/src/lib/hooks/use-projects.ts:16-21](../apps/client/src/lib/hooks/use-projects.ts#L16-L21) — repoint or rename
- [apps/api/src/routes/client.routes.ts:80-91](../apps/api/src/routes/client.routes.ts#L80-L91) — leave for now (admin); document as legacy
- [apps/client/src/app/approvals/page.tsx](../apps/client/src/app/approvals/page.tsx) — no page-level changes needed once the hook returns the right shape
- [apps/client/src/app/dashboard/page.tsx:45-69](../apps/client/src/app/dashboard/page.tsx#L45-L69) — same fix flows through

---

### ISSUE 4 — Sidebar approvals badge always shows "7" (P0)

**Symptom:** Sidebar reads "Approvals (7)" but the inbox is empty.

**Root cause:** `portal-rail.tsx:25` reads from the mock seed in `portal-store.ts`. That seed has 10 posts; the 7 that ship with `status: "PENDING"` produce the badge count. None of this is connected to the API.

**Fix:**
1. Stop reading from `usePortalStore` in `portal-rail.tsx`.
2. Use the same hook as the Approvals page (once Issue 3 is fixed, that's `useClientContent({ status: "PENDING_APPROVAL" })`).
3. Cache the count via SWR so the rail and page share a single revalidating request.

```tsx
const { data } = useClientContent({ status: "PENDING_APPROVAL" });
const pending = (data as any)?.data?.length ?? 0;
```

Also: keep the badge hidden until the SWR `isLoading` flips false to avoid a flash of "0" → real count.

**Files:**
- [apps/client/src/components/portal-rail.tsx:25, 80](../apps/client/src/components/portal-rail.tsx#L25)

---

### ISSUE 5 — Ctrl+K / Search button is decorative (P1)

**Symptom:** Cmd-K / Ctrl-K does nothing. Clicking the Search button does nothing.

**Root cause:** No handler bound. No command-palette component exists in the codebase.

**Fix (minimum viable):**
1. Add `onClick` to the search button → opens a modal.
2. Add a global `keydown` listener that intercepts `Cmd/Ctrl+K` and opens the same modal (and ignores it when typing in an input/textarea — see the existing `g d/p/c/a/n/f` pattern in `portal-rail.tsx:36-55`).
3. Inside the modal: a single text input + a list of nav targets (Projects, Content, Approvals, Analytics, Files), plus a future hook for fuzzy search over posts/projects. Even a "shell" palette (just routing) is enough to make the affordance honest.

**Files:**
- [apps/client/src/components/portal-topstrip.tsx:42-46](../apps/client/src/components/portal-topstrip.tsx#L42-L46)
- New: `apps/client/src/components/command-palette.tsx`

---

### ISSUE 6 — Notifications bell is decorative (P1)

**Symptom:** Bell icon is inert; red dot is permanently visible.

**Root cause:** No handler, no popover, no data source. The `Notification` model exists in `schema.prisma:43` (`User.notifications`) but no client-portal endpoint exposes notifications.

**Fix:**
- **Short term (this branch):** Hide the bell, or wire it to an "empty list" popover that says "You're all caught up." Remove the static red dot. This makes the UI honest without committing to a full notifications system.
- **Medium term (separate phase):** Add `GET /v1/client/notifications` reading from existing `Notification` model, paginated; `POST /v1/client/notifications/:id/read`. Wire the bell to a popover that lists unread notifications, displays a count badge derived from the response, and links each notification to its target (`/content/:id`, `/projects/:id`).

**Files:**
- [apps/client/src/components/portal-topstrip.tsx:48-50](../apps/client/src/components/portal-topstrip.tsx#L48-L50)
- Future: `apps/api/src/routes/client.routes.ts` + `apps/api/src/services/notification.service.ts` + `apps/client/src/lib/hooks/use-notifications.ts` + `apps/client/src/components/notification-popover.tsx`

---

### ISSUE 7 — "+ New Brief" does not exist (P0)

**Symptom:** User expects to be able to create a brief; nothing does that.

**Root cause:** The feature is not implemented. No button, no route, no endpoint.

**Open question (must answer before implementing):** **What is a "brief" in this product?**
Two interpretations are possible from the existing model:
- **(a)** A new content-post draft that the agency will fill in — the client kicks off the request, agency completes copy/visuals. In schema terms: `prisma.contentPost.create({ data: { status: "DRAFT", projectId, title, caption?, createdById } })`. The createdById would need to be the agency-side owner of the project — a `Project.ownerId` lookup, or a service convention.
- **(b)** A free-text request thread attached to a project — closer to a ticket. Schema would need a new `Brief` model with `title`, `description`, `projectId`, `clientId`, `status`, `messages`.

**Recommended:** Pick **(a)** if the team intends "brief" to mean "client-requested content draft" — it uses the existing schema. Pick (b) if briefs are first-class objects with their own lifecycle separate from content.

**Fix plan (assuming a):**
1. Add `POST /v1/client/content/brief` → creates a `ContentPost` with `status: "DRAFT"`, `createdById` set to the project's primary agency owner, `clientNote` (or new field) carrying the brief text.
2. Add `+ New Brief` button to the Content page header (next to List/Calendar toggle) and to the Dashboard ("New brief" CTA next to "Open inbox").
3. Modal: project picker → title → description → optional reference URL. On submit, `mutate("/client/content?…")`.

**Files (to create):**
- `apps/api/src/routes/client.routes.ts` — add route
- `apps/api/src/services/client.service.ts` — add `createClientBrief()`
- `packages/shared/src/validators/client.ts` — add `createBriefSchema`
- `apps/client/src/components/new-brief-modal.tsx`
- Hook into `apps/client/src/app/content/page.tsx` and dashboard

---

### ISSUE 8 — Content page silently shows empty (P1, conditional)

**Symptom:** Content page may show "No posts match" or 0 counts even with data.

**Root cause:** Same envelope read at line 19-20. Page does `(contentData as any)?.data ?? []` — **this is correct**. So this page should work *if the user has content posts in their account and the API auth is valid*.

**Verify before fixing:** Confirm via the API the user actually has content posts. If they don't, the page is correctly displaying empty — not a bug, just a discoverability problem (which is exactly Issue 7, "no way to create content").

**Files:**
- [apps/client/src/app/content/page.tsx:19](../apps/client/src/app/content/page.tsx#L19) — already correct
- Likely root cause: no content seeded → Issue 7 fix unblocks this page

---

### ISSUE 9 — Approvals badge counts every approval, not just pending (P2)

**Symptom:** Even if Issues 3 & 4 are fixed naively, the count could include non-pending records.

**Root cause:** `useClientApprovals()` in `use-projects.ts:16-21` doesn't pass `?status=PENDING` by default. Server returns all statuses; consumers must filter client-side.

**Fix:** When repointing the hook for Issue 4, **always pass `status: "PENDING_APPROVAL"`** so the count and the page list are aligned by construction.

**Files:**
- [apps/client/src/lib/hooks/use-projects.ts:16-21](../apps/client/src/lib/hooks/use-projects.ts#L16-L21)

---

### ISSUE 10 — Inconsistent envelope unwrap convention (P2)

**Symptom:** Maintenance hazard. Some hooks unwrap (`useClientFiles` type says inner but returns outer), some pages unwrap (`(raw as any)?.data`), and there is no single rule.

**Root cause:** No documented contract for whether `apiFetch` unwraps. Today it does not.

**Fix:** Pick one of:
- **(A) Unwrap at `apiFetch`** — change `return data` → `return data.data` in `api.ts`. Update meta-aware callers (which read `meta`) to use a sibling helper or destructure the full envelope explicitly. This is the cleanest call site experience but touches every hook.
- **(B) Unwrap at each hook** — every `useSWR` factory does `(await apiFetch(url)).data` internally and types accordingly. Pages stop doing `(raw as any)?.data`.
- **(C) Leave `apiFetch` as-is, do `?.data` at every page.** This is what most of the codebase does today; the bug is just that **two hooks lied about their types**.

**Recommendation:** **(B).** Centralizes the contract, gives accurate types, and avoids surprising every page. (A) is tempting but the meta paginator escapes the abstraction. (C) requires removing the type lies which forces the same diff anyway.

Document the chosen convention at the top of `apps/client/src/lib/api.ts`.

**Files:**
- [apps/client/src/lib/api.ts](../apps/client/src/lib/api.ts)
- All hooks under `apps/client/src/lib/hooks/`

---

### ISSUE 11 — Auth race on first paint (P2)

**Symptom:** The sidebar can flash `USER.name` ("Priya K.") before the real auth user resolves.

**Root cause:** `portal-rail.tsx:58-60` falls back to the mock `USER` whenever `useAuth()` hasn't populated. There's no loading guard.

**Fix:** Hide the avatar row until `user` is non-null, or show a tiny skeleton. Same applies to the company name in the rail.

**Files:**
- [apps/client/src/components/portal-rail.tsx:58-60, 121-128](../apps/client/src/components/portal-rail.tsx#L58-L60)

---

### ISSUE 12 — Repo hygiene cruft (P3)

- **`nul` file in repo root.** Looks like a Windows shell `> nul` mistake captured by git as a real file. Delete it.
- **`apps/api/src/services/client.service.ts`** is untracked but referenced by `client.routes.ts:12` and `client.routes.ts:185-194`. The Files endpoint depends on it — **if this file isn't committed, anyone else who pulls the branch will see Files break with a build error.** Stage and commit.
- **`apps/client/tsconfig.tsbuildinfo`** appears in `git status` as modified. It should be in `.gitignore`. Add it.
- **`.claude/worktrees/`, `.claude/settings.local.json`, `.planning/`, `.github/`** are all untracked. Confirm these should remain so (they probably should, but the user should decide explicitly).

**Files:**
- `nul` (delete)
- `.gitignore` (add `tsconfig.tsbuildinfo`, confirm `.claude/`)
- `apps/api/src/services/client.service.ts` (commit)

---

## Summary table

| # | Issue | User-visible symptom | Severity | Status |
|---|---|---|---|---|
| 1 | Analytics page renders zeros / "no data" | "Analytics depicts nothing" | P0 | ✅ Fixed `af1abd5` (Wave 1) |
| 2 | Files page never lists | "Files doesn't work or is not apparent" | P0 | ✅ Fixed `af1abd5` (Wave 1) |
| 3 | Approvals hits wrong resource (Approval vs ContentPost) | "Approvals doesn't work" | P0 | ✅ Fixed `96fe6bc` (Wave 2) |
| 4 | Sidebar approvals badge from mock store | "Approvals depicts '7' on the sidebar" | P0 | ✅ Fixed `96fe6bc` (Wave 2) |
| 5 | Ctrl+K & Search button not wired | "Ctrl+K doesn't work and search button is not clickable" | P1 | ✅ Fixed `e1b874a` (Wave 4) |
| 6 | Notifications bell not wired | "Notifications doesn't work" | P1 | ✅ Bell removed `e1b874a` (Wave 4); full notifications deferred |
| 7 | No "+ New Brief" entry point in code | "+ New Brief doesn't work" | P0 | ✅ Fixed `e45a11f` (Wave 3) |
| 8 | Content page may show empty (no seed) | "Content doesn't work" | P1 | ✅ Unblocked by Wave 1 + seed data in `3c39f45` |
| 9 | Approvals count includes non-pending | (latent) | P2 | ✅ Fixed `96fe6bc` (Wave 2) |
| 10 | Inconsistent envelope unwrap | (latent) | P2 | ✅ Fixed `af1abd5` (Wave 1) |
| 11 | Mock user flash before auth resolves | (cosmetic) | P2 | ✅ Fixed `96fe6bc` (Wave 2/5) |
| 12 | `nul` file, untracked `client.service.ts`, stray buildinfo | (repo hygiene) | P3 | ✅ Fixed `aa453df` (Wave 0) |

---

## Remediation plan — wave order

Each wave is the smallest unit that can ship and verify independently. Estimates are rough.

### Wave 0 — Hygiene & unblock build ✅ `aa453df`
1. ~~Commit `apps/api/src/services/client.service.ts` (currently untracked but imported).~~ Done.
2. ~~Delete the `nul` file.~~ Done.
3. ~~Add `apps/client/tsconfig.tsbuildinfo` to `.gitignore`.~~ Done. Also added `nul`, `.claude/settings.local.json`, `.claude/worktrees/`.
4. `.planning/` + `.github/` kept tracked; `.claude/` remains untracked.

**Verification:** Build-breaking import is now tracked; `.gitignore` covers all build artifacts.

---

### Wave 1 — Fix data-binding bugs ✅ `af1abd5`

All hooks unwrap `.data` at the fetcher layer. `apiFetch<T>()` typed as `Promise<ApiEnvelope<T>>` with documented contract at top of `api.ts`. All `(raw as any)?.data` reads removed from pages. Non-paginated hooks return `T`; paginated hooks return `{items, meta}`.

---

### Wave 2 — Approvals repoint + sidebar badge ✅ `96fe6bc`

`useClientPendingApprovals` → `GET /client/content?status=PENDING_APPROVAL&limit=100`. `PENDING_APPROVALS_KEY` constant shared by approvals page, dashboard, content/[id], and sidebar rail. Rail badge hidden until hook resolves. Auth mock fallback removed from rail.

---

### Wave 3 — "+ New Brief" ✅ `e45a11f`

Brief = draft `ContentPost`. `POST /v1/client/content/brief` endpoint + `createClientBrief()` service + `createBriefSchema` validator + `NewBriefModal` component + entry points on Dashboard / Projects / Content topstrips. Invalidates all `/client/content*` SWR keys on success.

---

### Wave 4 — Command palette + bell ✅ `e1b874a`

`CommandPalette` component mounted in `PortalShell`. Cmd/Ctrl+K toggles globally. Search button opens. Lists Pages + every Project; ↑↓/↵/Esc fully wired. Notifications bell removed entirely (static red dot was misleading; full notifications system deferred to a future phase).

### Wave 4b — Notifications (real) — deferred
Out of scope for this branch. `Notification` Prisma model is available; add `GET /v1/client/notifications` + popover in a future phase.

---

### Wave 5 — Auth & polish ✅ `96fe6bc` / `3c39f45`

Auth flash fixed: rail renders animated skeleton until `useAuth().user` resolves. `loading.tsx` files added to all 8 route folders. `portal-store` still imported for `Actions.toast` and `fmt` helpers only — no longer drives page data.

---

## Decisions (resolved)

1. **Envelope convention:** Hook-level unwrap adopted. `apiFetch` returns full envelope; hooks unwrap `.data`.
2. **Approvals semantics:** Option A confirmed. Approvals page displays `ContentPost` records with `status = PENDING_APPROVAL`. Legacy `/v1/client/approvals` endpoint kept but marked admin-only.
3. **"Brief" definition:** Draft `ContentPost`. `POST /v1/client/content/brief` creates a `ContentPost` with `status: "DRAFT"`.
4. **Notifications scope:** Bell removed for now. Full notifications system deferred to a future phase.

---

## Out of scope for this audit
- Performance / caching strategy beyond what SWR already provides.
- E2E test coverage (worth adding once Wave 1 lands).
- Visual / design review (covered by the `docs/design-critique` branch's intent).
- Internal employee, HR, and Jobs portals.
