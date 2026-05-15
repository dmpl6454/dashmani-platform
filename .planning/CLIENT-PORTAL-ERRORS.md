# Client Portal — Error Log

**Purpose:** A living log of concrete errors observed in the client portal — from static analysis, runtime reproduction, server logs, browser console, and user reports. Each entry is a self-contained record so that anyone fixing the bug doesn't need to re-derive the context.

**How to use this file:**
- When a new error is observed, append an entry under "Open errors" using the template at the bottom.
- When an error is fixed, move it to "Resolved errors" with the resolving commit hash and verification notes.
- Pair each entry with the corresponding **Issue #** in [CLIENT-PORTAL-AUDIT.md](./CLIENT-PORTAL-AUDIT.md) when one exists.
- Keep entries terse but precise. Stack traces, request/response pairs, and reproduction steps go inside the entry, not in a separate file.

---

## Open errors

_(none — all issues resolved as of 2026-05-15)_

---

## Resolved errors

### ERR-001 — `useClientAnalytics` returns the envelope, not the analytics payload

- **Linked to:** AUDIT Issue 1
- **Severity:** P0
- **Type:** Static (TypeScript type lie) + Runtime (page renders all-zero state)
- **Location:**
  - [apps/client/src/lib/hooks/use-analytics.ts:20-23](../apps/client/src/lib/hooks/use-analytics.ts#L20-L23)
  - [apps/client/src/app/analytics/page.tsx:74, 89-97](../apps/client/src/app/analytics/page.tsx#L74)
- **Symptom:** `/analytics` shows zeros across the board and empty charts.
- **Trigger:** Navigate to `/analytics` while logged into the client portal.
- **What's actually happening:**
  - `apiFetch<T>` returns `{success: true, data: T}` (the full envelope) — see [apps/client/src/lib/api.ts:28](../apps/client/src/lib/api.ts#L28).
  - The hook was typed as `useSWR<ClientAnalytics>` but actually resolved to `{success, data: ClientAnalytics}`.
  - The page read `data.totalPosts` directly → always `undefined`.
  - `data && data.totalPosts === 0` is `undefined === 0` → `false`, so the empty-state branch didn't fire either.
- **Status:** Resolved in `af1abd5` (Wave 1 — envelope unwrap). Hook now unwraps `.data` in the fetcher; `apiFetch` documented contract added at top of `api.ts`.

---

### ERR-002 — `useClientFiles` returns the envelope, not the file array

- **Linked to:** AUDIT Issue 2
- **Severity:** P0
- **Type:** Static (TypeScript type lie) + Runtime (list never renders, empty state never resolves)
- **Location:**
  - [apps/client/src/lib/hooks/use-files.ts:20-23](../apps/client/src/lib/hooks/use-files.ts#L20-L23)
  - [apps/client/src/app/files/page.tsx:30, 36, 115, 167](../apps/client/src/app/files/page.tsx#L30)
- **Symptom:** Files page header shows "undefined files" or no count; rows never appear; empty state never appears either.
- **Trigger:** Navigate to `/files`.
- **What's actually happening:**
  - Hook was typed `useSWR<ClientFile[]>` but resolved to `{success, data: ClientFile[]}`.
  - `data.length` → `undefined`. Both the row list and empty state conditions were never truthy.
- **Status:** Resolved in `af1abd5` (Wave 1 — envelope unwrap). Hook fetcher unwraps `.data`.

---

### ERR-003 — Approvals page consumes the wrong resource model

- **Linked to:** AUDIT Issue 3
- **Severity:** P0
- **Type:** API/UI contract mismatch (two different Prisma models)
- **Location:**
  - Server: [apps/api/src/routes/client.routes.ts:80-91](../apps/api/src/routes/client.routes.ts#L80-L91)
  - Client hook: [apps/client/src/lib/hooks/use-content.ts](../apps/client/src/lib/hooks/use-content.ts)
  - Client page: [apps/client/src/app/approvals/page.tsx](../apps/client/src/app/approvals/page.tsx)
- **Symptom:**
  - Approval rows rendered with `undefined` thumbnails, format pills, scheduled times, captions, hashtags, author names.
  - Clicking Approve / Revise / Reject surfaced "Could not approve" toast (API returned 404).
- **What was actually happening:**
  - `GET /v1/client/approvals` returned `Approval` model rows; page expected `ContentPost` shape.
  - PUT called `/client/content/<approval.id>/respond` but `Approval.id ≠ ContentPost.id` → 404.
- **Status:** Resolved in `96fe6bc` (Wave 2). `useClientPendingApprovals` now calls `GET /client/content?status=PENDING_APPROVAL&limit=100`. PUT target is now a real `ContentPost.id`. `/v1/client/approvals` marked LEGACY in routes.

---

### ERR-004 — Sidebar approvals badge driven by mock seed, not API

- **Linked to:** AUDIT Issue 4
- **Severity:** P0
- **Type:** Mock data leaking into production paths
- **Location:** [apps/client/src/components/portal-rail.tsx:25](../apps/client/src/components/portal-rail.tsx#L25)
- **Symptom:** Approvals badge showed `7` regardless of real approval state.
- **What was actually happening:**
  - `portal-rail.tsx:25` read `usePortalStore((s) => s.posts.filter(...).length)`.
  - `portal-store.ts` seeded 10 mock posts at module load; 7 had `status: "PENDING"`.
- **Status:** Resolved in `96fe6bc` (Wave 2). Rail now reads from `useClientPendingApprovals`; badge hidden until hook resolves to avoid flash.

---

### ERR-005 — Ctrl+K / Search button has no handler

- **Linked to:** AUDIT Issue 5
- **Severity:** P1
- **Type:** Inert UI control (false affordance)
- **Location:** [apps/client/src/components/portal-topstrip.tsx:42-46](../apps/client/src/components/portal-topstrip.tsx#L42-L46)
- **Symptom:** Clicking Search button or pressing Cmd/Ctrl+K did nothing.
- **Status:** Resolved in `e1b874a` (Wave 4). `CommandPalette` component mounted in `PortalShell`; Topstrip search button calls `palette.open()`; global `keydown` listener for Cmd/Ctrl+K inside `CommandPalette`.

---

### ERR-006 — Notifications bell has no handler and a static red dot

- **Linked to:** AUDIT Issue 6
- **Severity:** P1
- **Type:** Inert UI control + permanently-on indicator
- **Location:** [apps/client/src/components/portal-topstrip.tsx:48-50](../apps/client/src/components/portal-topstrip.tsx#L48-L50)
- **Symptom:** Bell icon did nothing; red dot was always visible regardless of notifications.
- **Status:** Resolved in `e1b874a` (Wave 4). Bell removed entirely. Full notifications system deferred to a future phase (no client endpoint exists yet; `Notification` Prisma model is available when ready).

---

### ERR-007 — "+ New Brief" entry point does not exist

- **Linked to:** AUDIT Issue 7
- **Severity:** P0
- **Type:** Missing feature
- **Status:** Resolved in `e45a11f` (Wave 3). `POST /v1/client/content/brief` endpoint, `createClientBrief()` service method, `createBriefSchema` validator, `NewBriefModal` component, and entry points on Dashboard / Projects / Content topstrip all implemented.

---

### ERR-008 — `useClientApprovals` does not constrain status

- **Linked to:** AUDIT Issue 9
- **Severity:** P2
- **Type:** Hook contract / latent
- **Location:** [apps/client/src/lib/hooks/use-content.ts](../apps/client/src/lib/hooks/use-content.ts)
- **Status:** Resolved in `96fe6bc` (Wave 2). `useClientPendingApprovals` always passes `status=PENDING_APPROVAL`; the old `useClientApprovals` hook deleted.

---

### ERR-009 — `apps/api/src/services/client.service.ts` is untracked but imported

- **Linked to:** AUDIT Issue 12
- **Severity:** P0 (build-breaking on fresh checkout) / P3 (repo hygiene)
- **Type:** Repo hygiene → build hazard
- **Status:** Resolved in `aa453df` (Wave 0). File staged and committed.

---

### ERR-010 — Stray `nul` file committed to repo root

- **Linked to:** AUDIT Issue 12
- **Severity:** P3
- **Type:** Repo hygiene
- **Status:** Resolved in `aa453df` (Wave 0). File deleted; `nul` added to `.gitignore`.

---

### ERR-011 — `apps/client/tsconfig.tsbuildinfo` is tracked

- **Linked to:** AUDIT Issue 12
- **Severity:** P3
- **Type:** Repo hygiene (build artifact in VCS)
- **Status:** Resolved in `aa453df` (Wave 0). `git rm --cached`; `*.tsbuildinfo` added to `.gitignore`.

---

### ERR-012 — Auth user can flash mock identity before resolving

- **Linked to:** AUDIT Issue 11
- **Severity:** P2
- **Type:** Cosmetic race
- **Location:** [apps/client/src/components/portal-rail.tsx:58-60, 121-128](../apps/client/src/components/portal-rail.tsx#L58-L60)
- **Symptom:** Bottom-left chip could flash "Priya K. — Bombay Roastery" before the real auth user settled.
- **Status:** Resolved in `96fe6bc` (Wave 2 / Wave 5 polish). `USER` mock fallback removed from `portal-rail.tsx`; renders animated skeleton until `useAuth().user` is non-null.

---

## Append template

```markdown
### ERR-NNN — <one-line title>

- **Linked to:** AUDIT Issue N (or "—" if none)
- **Severity:** P0 | P1 | P2 | P3
- **Type:** Runtime | Static | API/UI contract | Repo hygiene | Inert UI | Mock-data leak | Missing feature | Other
- **Location:** `path/to/file.ts:line` (link with markdown if useful)
- **Symptom:** What the user sees.
- **Trigger:** Exact steps to reproduce.
- **What's actually happening:** The mechanism — request/response, type chain, state shape, etc.
- **Expected vs actual:** (if relevant; can include sample JSON)
- **Status:** Open / In progress / Resolved in `<commit>`
```
