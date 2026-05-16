# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Monorepo Structure

Turborepo + npm workspaces with five apps and three shared packages:

| App | Port | Purpose |
|-----|------|---------|
| `apps/api` | 4000 | Express REST API — the only backend |
| `apps/internal` | 3000 | Internal employee portal (Next.js) |
| `apps/client` | 3001 | Client-facing portal (Next.js) |
| `apps/hr` | 3002 | HR management portal (Next.js) |
| `apps/jobs` | 3003 | Public job listings portal (Next.js) |

| Package | Purpose |
|---------|---------|
| `packages/db` | Prisma client + schema (single source of truth for DB) |
| `packages/shared` | Zod validators, TypeScript types, constants — shared across all apps |
| `packages/ui` | Radix UI + Tailwind component library (Button, Card, Badge, etc.) |

## Commands

```bash
# Root — runs all apps in parallel via Turbo
npm run dev

# Individual apps (run from their directory or use -w flag)
npm run dev -w @dashmani/api
npm run dev -w @dashmani/client

# Database (run from root — delegates to packages/db)
npm run db:generate   # After editing prisma/schema.prisma
npm run db:push       # Sync schema to local DB (no migration files)
npm run db:seed       # Seed initial data
npm run db:studio     # Open Prisma Studio GUI

# Tests (API only — Vitest)
npm run test -w @dashmani/api
npm run test:watch -w @dashmani/api

# Build & lint
npm run build
npm run lint
```

## Local Infrastructure

```bash
# Start PostgreSQL (5432) and Redis (6379)
docker-compose up -d
```

Copy `.env.example` → `.env` before first run. The docker-compose credentials match the example file exactly.

**Email (SMTP):** `apps/api/.env` must include SMTP vars for any email features (announcement broadcasts, invite emails, HR notifications) to work. Without them, `sendEmail()` silently no-ops with a console warning. This is a **one-time server config** — not per-user. All system emails send from a shared outbox (`hr@digitalsukoon.com`).

| Var | Local dev | Production |
|-----|-----------|------------|
| `SMTP_HOST` | `smtp.gmail.com` | `smtp.gmail.com` |
| `SMTP_PORT` | `587` | `587` |
| `SMTP_SECURE` | `false` | `false` |
| `SMTP_USER` | `hr@digitalsukoon.com` | `hr@digitalsukoon.com` |
| `SMTP_PASS` | Gmail App Password | same |
| `INTERNAL_APP_URL` | `http://localhost:3000` | `https://portal.digitalsukoon.com` |
| `HR_APP_URL` | `http://localhost:3002` | `https://hr.digitalsukoon.com` |

`INTERNAL_APP_URL` controls the "Open Portal →" link in emails — wrong value means broken links for recipients. The code falls back to `https://portal.digitalsukoon.com` if unset. See `.env.example` for the full template. Gmail App Password: Google Account → Security → App Passwords (requires 2FA).

### Environment URL switching

Each frontend app has an `apps/<app>/.env.local` file controlling `NEXT_PUBLIC_API_URL`.

**Current state (local dev):** All `.env.local` files point to `http://localhost:4000/v1`.

**Production URL:** `https://api.digitalsukoon.com/v1` — verified to exist but may have issues. Original `.env.local` files all had this value.

**To revert all apps to production API:**
```bash
# Run from repo root
for app in client internal hr jobs; do
  echo "NEXT_PUBLIC_API_URL=https://api.digitalsukoon.com/v1" > "apps/$app/.env.local"
done
```

**To set back to localhost (local dev):**
```bash
for app in client internal hr jobs; do
  echo "NEXT_PUBLIC_API_URL=http://localhost:4000/v1" > "apps/$app/.env.local"
done
```

## Architecture

### API (`apps/api`)

Middleware chain: `helmet → cors → rate-limit → auth middleware → RBAC → route handler`

Three separate auth middlewares in `src/middleware/`:
- `auth.ts` — internal employee authentication
- `client-auth.ts` — client portal authentication
- `hr-auth.ts` — HR portal authentication

RBAC (`src/middleware/rbac.ts`) uses a permission model of `{resource}.{action}.{scope}` where scope is `own | team | department | global` (higher scope wins). Roles/permissions live in the DB via Prisma models `Role`, `UserRole`, `RolePermission`.

Rate limits: global 1000 req/15min, auth endpoints 20 req/15min, public job apply 10 req/hr.

All API responses use a `{success: boolean, data|error}` envelope.

### Frontend Apps

All four Next.js apps share the same stack: **App Router**, **SWR** for data fetching, **Tailwind CSS**, `@dashmani/ui` components, and a centralized API client at `src/lib/api.ts`. They do not share pages or components with each other — each is independently deployable.

`NEXT_PUBLIC_API_URL` points all frontends at the Express API (`http://localhost:4000/v1` locally).

### Database

All schema changes go through `packages/db/prisma/schema.prisma`. Run `db:generate` after any schema edit so the Prisma client types regenerate across the monorepo. The project uses `db push` (no migration history) rather than `prisma migrate`.

## Key Conventions

- API versioning prefix: `/v1/`
- Shared Zod schemas in `packages/shared/src/validators/` are used on both API (input validation) and frontends (form validation) — don't duplicate validators in app code.
- Cron jobs live in `apps/api/src/cron/` and are bootstrapped in `src/index.ts`.
- Business logic belongs in `apps/api/src/services/`, not in route handlers.

## Client Portal (`apps/client`) — Implementation Status

All 9 implementation phases + 5-wave audit remediation complete. See `.planning/CLIENT-PORTAL-AUDIT.md` for the full issue register and resolution commit log.

### What's implemented

**DB Schema** (`packages/db/prisma/schema.prisma`):
- `ContentPost` extended with `format`, `aspectRatio`, `hashtags`
- `Project` extended with `healthScore`
- `PostComment` model (linked to `ContentPost` + `User`)
- `ClientInvite` model (invite-based signup flow)

**API endpoints** (`apps/api/src/routes/client.routes.ts`):
- `POST /v1/client/auth/invite-request` — admin creates invite (protected)
- `POST /v1/client/auth/register` — public invite acceptance + account creation
- `GET/POST /v1/client/content/:id/comments` — discussion thread
- `GET /v1/client/files` — aggregated file browser across projects
- `GET /v1/client/analytics` — client-scoped analytics (calls `getClientContentAnalytics`)
- `POST /v1/client/content/brief` — create a draft ContentPost ("brief") from the client
- `GET /v1/client/approvals` — **LEGACY / admin-only**, not used by client portal

**Frontend pages** (all use real SWR hooks, no mock store data):
- `/signup` — invite token flow, matches login card style
- `/dashboard` — live approvals queue + analytics stats via SWR
- `/projects` — project list with health bars via SWR
- `/projects/[id]` — project detail via SWR
- `/content` — list + calendar toggle; calendar uses `ContentCalendar` component
- `/content/[id]` — post detail, IG previews, real comments, approve/revise/reject wired to API
- `/approvals` — split-view inbox wired to `ContentPost?status=PENDING_APPROVAL`, all actions via API
- `/analytics` — recharts PieChart + BarChart + project table
- `/files` — file browser with project filter, `formatBytes`, download links

**Shared components** (`apps/client/src/components/`):
- `portal-shared.tsx`: `Skeleton`, `PageError`, `Modal`, `Button`, `Avatar`, etc.
- `command-palette.tsx`: Cmd/Ctrl+K global search — pages + projects, ↑↓/↵/Esc
- `new-brief-modal.tsx`: project picker + title + description + optional reference URL
- `content-calendar.tsx`: month grid with `FormatPill` stacks, prev/next navigation

**Loading states**: `loading.tsx` exists in all 8 route folders.

### API envelope convention
`apiFetch<T>()` returns `Promise<ApiEnvelope<T>>` — the full `{success, data, meta?}` envelope. Hooks under `lib/hooks/` unwrap `.data` in their fetcher. Pages consume hook return values directly — no `?.data` reads in page code.

### Key design notes
- `portal-store` (`lib/portal-store.ts`) is still imported for `Actions` (toast) and `fmt` (date formatting) helpers only — it no longer drives page data.
- Approvals page and sidebar badge both use `useClientPendingApprovals` (shared SWR key = `PENDING_APPROVALS_KEY`). Badge is hidden until the hook resolves to avoid a flash from 0 → real count.
- `addPostComment` resolves `clientId → client.email → User.id` to satisfy the `PostComment.authorId → User` FK.
- `GET /v1/client/analytics` calls `analyticsService.getClientContentAnalytics(clientId)` (not `getClientAnalytics`).
- `createClientBrief` resolves `createdById` via fallback: recent post creator → recent task creator → any active user in the project's org.
