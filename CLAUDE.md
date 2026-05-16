# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## First-time Setup (macOS or Windows)

Follow these steps exactly on a fresh clone. All commands run from the **repo root** unless noted.

### 1. Prerequisites

These are the **only** system-level tools you need — everything else installs via `npm install`.

| Tool | Required version | macOS install | Windows install |
|------|-----------------|---------------|-----------------|
| **Node.js** | 22.x LTS | `brew install node` or https://nodejs.org | https://nodejs.org (LTS installer — check "Add to PATH") |
| **npm** | 10.x or 11.x (bundled with Node) | comes with Node | comes with Node |
| **Git** | any | `brew install git` or https://git-scm.com | https://git-scm.com (includes Git Bash) |
| **Docker Desktop** | latest | https://www.docker.com/products/docker-desktop | https://www.docker.com/products/docker-desktop |

**That's it.** No Python, Java, Ruby, Rust, or any other runtime is needed. All project tooling (TypeScript, Prisma, Turbo, tsx, ESLint, Vitest) installs automatically as npm packages.

#### macOS — install everything in one go with Homebrew

If you don't have Homebrew: `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`

```bash
brew install node git
# Then install Docker Desktop manually from https://www.docker.com/products/docker-desktop
```

#### Windows — install order matters

1. Install **Git for Windows** from https://git-scm.com — this also gives you Git Bash (a proper bash shell)
2. Install **Node.js LTS** from https://nodejs.org — tick "Add to PATH"
3. Install **Docker Desktop** from https://www.docker.com/products/docker-desktop
4. Restart your terminal after each install

#### Verify everything is installed

```bash
node --version    # should print v22.x.x
npm --version     # should print 10.x.x or 11.x.x
git --version     # any version
docker --version  # any recent version
```

### 2. Clone the repo

```bash
git clone https://github.com/dmpl6454/dashmani-platform.git
cd dashmani-platform
```

### 3. Install dependencies

```bash
npm install
```

This installs all workspace dependencies across all apps and packages in one shot via Turborepo.

### 4. Create environment files

The `.env` files are gitignored — you must create them manually. Run the following block in your terminal (works on both macOS/Linux bash and Windows Git Bash):

```bash
# Root .env (used by Turbo and most scripts)
cp .env.example .env

# API .env (used by the Express server at runtime)
cp .env.example apps/api/.env

# packages/db .env (used by Prisma CLI — seed, push, studio)
cp .env.example packages/db/.env
```

Then create `.env.local` for each frontend app (controls which API URL they point to):

**macOS / Linux:**
```bash
for app in client internal hr jobs; do
  echo "NEXT_PUBLIC_API_URL=http://localhost:4000/v1" > "apps/$app/.env.local"
done
```

**Windows (PowerShell):**
```powershell
foreach ($app in @("client","internal","hr","jobs")) {
  Set-Content "apps/$app/.env.local" "NEXT_PUBLIC_API_URL=http://localhost:4000/v1"
}
```

**Windows (CMD):**
```cmd
for %a in (client internal hr jobs) do echo NEXT_PUBLIC_API_URL=http://localhost:4000/v1 > apps\%a\.env.local
```

> The default `.env.example` values work for local dev with no changes. The only value you may want to update is `SMTP_PASS` if you need emails to actually send.

### 5. Start Docker (PostgreSQL + Redis)

Make sure Docker Desktop is running, then:

```bash
docker-compose up -d
```

This starts:
- PostgreSQL 16 on port `5432` (user: `user`, password: `password`, db: `dashmani`)
- Redis 7 on port `6379`

Verify both are healthy:
```bash
docker ps
```
Both containers should show `(healthy)`.

### 6. Set up the database

```bash
# Generate the Prisma client (must run after any schema change too)
npm run db:generate

# Push schema to the local database (creates all tables)
npm run db:push

# Seed initial data (roles, admin user, platforms, demo client)
npm run db:seed
```

`db:seed` reads `SEED_ADMIN_PASSWORD` from `packages/db/.env` (copied from `.env.example` in step 4). The default is `Admin@123456`.

After seeding, the admin login is:
- **Email:** `admin@digitalsukoon.com`
- **Password:** `Admin@123456` (or whatever you set in `SEED_ADMIN_PASSWORD`)

### 7. Run the dev servers

```bash
npm run dev
```

This starts all five apps in parallel via Turborepo:

| App | URL |
|-----|-----|
| API | http://localhost:4000 |
| Internal Portal | http://localhost:3000 |
| Client Portal | http://localhost:3001 |
| HR Portal | http://localhost:3002 |
| Jobs Portal | http://localhost:3003 |

---

## Production URLs

| Service | URL |
|---------|-----|
| API | https://api.digitalsukoon.com/v1 |
| Internal Portal | https://portal.digitalsukoon.com |
| Client Portal | https://client.digitalsukoon.com |
| HR Portal | https://hr.digitalsukoon.com |
| Jobs Portal | https://jobs.digitalsukoon.com |

Production runs on Linode VPS `172.105.53.101`. Connect with `ssh linode`.

---

## Deployment (CI/CD)

Pushing to `main` automatically deploys to production via GitHub Actions (`.github/workflows/deploy.yml`).

**Flow:** GitHub Actions SSHes into the Linode server and runs `scripts/deploy.sh`:
1. `git fetch origin main && git reset --hard origin/main` (no merge conflicts ever)
2. `npm install`
3. `npx turbo build --concurrency=1` with `NODE_OPTIONS=--max-old-space-size=900` (sequential to manage 2GB RAM)
4. `pm2 restart all && pm2 save`

**Required GitHub secrets** at `github.com/dmpl6454/dashmani-platform/settings/secrets/actions`:

| Secret | Value |
|--------|-------|
| `DEPLOY_HOST` | `172.105.53.101` |
| `DEPLOY_USER` | `root` |
| `DEPLOY_SSH_KEY` | Deploy private key (regenerate if lost) |

**Database changes are NEVER run by CI/CD.** If you change `schema.prisma`, SSH in manually:
```bash
ssh linode
cd /opt/dashmani-platform
npm run db:generate && npm run db:push
```

---

## Environment Files Reference

### Which file does what

| File | Read by | Purpose |
|------|---------|---------|
| `.env` | Turbo, root scripts | Shared vars passed to all workspaces |
| `apps/api/.env` | Express server at runtime | API secrets, SMTP, app URLs |
| `packages/db/.env` | Prisma CLI (seed, push, studio) | `DATABASE_URL` + `SEED_ADMIN_PASSWORD` |
| `apps/*/env.local` | Next.js build | `NEXT_PUBLIC_API_URL` per frontend |

All three `.env` files (root, api, db) need the same `DATABASE_URL` and `JWT_SECRET` values. The `.env.example` template works for all three.

### Key variables

| Variable | Default | Notes |
|----------|---------|-------|
| `DATABASE_URL` | `postgresql://user:password@localhost:5432/dashmani` | Matches docker-compose defaults |
| `REDIS_URL` | `redis://localhost:6379` | Matches docker-compose defaults |
| `JWT_SECRET` | `change-me-in-production` | Change for production |
| `JWT_REFRESH_SECRET` | `change-me-in-production-refresh` | Change for production |
| `SEED_ADMIN_PASSWORD` | `Admin@123456` | Password set for admin@digitalsukoon.com on seed |
| `INTERNAL_APP_URL` | `http://localhost:3000` | Used in reset-password email links |
| `HR_APP_URL` | `http://localhost:3002` | Used in HR notification emails |
| `SMTP_HOST` | `smtp.gmail.com` | Optional — emails no-op if SMTP_PASS missing |
| `SMTP_USER` | `hr@digitalsukoon.com` | Gmail sender address |
| `SMTP_PASS` | *(blank)* | Gmail App Password — Google Account → Security → App Passwords |

### Switching between local dev and production API

**Point all frontends at production API:**
```bash
# macOS / Linux
for app in client internal hr jobs; do
  echo "NEXT_PUBLIC_API_URL=https://api.digitalsukoon.com/v1" > "apps/$app/.env.local"
done
```

**Point all frontends back at localhost:**
```bash
# macOS / Linux
for app in client internal hr jobs; do
  echo "NEXT_PUBLIC_API_URL=http://localhost:4000/v1" > "apps/$app/.env.local"
done
```

---

## Commands

```bash
# Run all apps in parallel
npm run dev

# Run a specific app
npm run dev -w @dashmani/api
npm run dev -w @dashmani/internal
npm run dev -w @dashmani/client
npm run dev -w @dashmani/hr

# Database (always run from repo root)
npm run db:generate   # Regenerate Prisma client after schema changes
npm run db:push       # Sync schema.prisma to local DB (no migration files)
npm run db:seed       # Seed roles, admin user, platforms, demo client
npm run db:studio     # Open Prisma Studio GUI at http://localhost:5555

# Tests (API only — Vitest)
npm run test -w @dashmani/api
npm run test:watch -w @dashmani/api

# Build all apps
npm run build

# Lint all apps
npm run lint
```

---

## Monorepo Structure

Turborepo + npm workspaces:

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
| `packages/shared` | Zod validators, TypeScript types, `formatStatus()`, `safeString` — shared across all apps |
| `packages/ui` | Radix UI + Tailwind component library (Button, Card, Badge, etc.) |

---

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

---

## Key Conventions

- API versioning prefix: `/v1/`
- Shared Zod schemas in `packages/shared/src/validators/` are used on both API (input validation) and frontends (form validation) — don't duplicate validators in app code.
- Use `safeString` from `packages/shared/src/utils/sanitize.ts` instead of `z.string()` for any free-text user input field (name, title, description, etc.) — strips HTML tags at the API boundary.
- Use `formatStatus()` from `packages/shared/src/utils/status.ts` whenever displaying enum status values in the UI — converts `UPPER_SNAKE_CASE` to "Title Case".
- Cron jobs live in `apps/api/src/cron/` and are bootstrapped in `src/index.ts`.
- Business logic belongs in `apps/api/src/services/`, not in route handlers.

---

## Shared Utilities (`packages/shared/src/utils/`)

### `formatStatus(value: string): string`
Converts `UPPER_SNAKE_CASE` enum values to "Title Case" for display.
```ts
import { formatStatus } from "@dashmani/shared";
formatStatus("IN_PROGRESS")   // → "In Progress"
formatStatus("PENDING_APPROVAL") // → "Pending Approval"
```

### `safeString` (Zod transformer)
Strips HTML/script tags and trims whitespace. Use in validators instead of `z.string()` for text fields.
```ts
import { safeString } from "@dashmani/shared";
const schema = z.object({ name: safeString.pipe(z.string().min(2).max(100)) });
```

### `usePageTitle(title: string)` hook (`apps/internal/src/lib/hooks/use-page-title.ts`)
Sets `document.title` to `"${title} — Dashmani Portal"` on mount.
```ts
import { usePageTitle } from "@/lib/hooks/use-page-title";
export default function MyPage() {
  usePageTitle("My Page");
  // ...
}
```

---

## Auth Flow

1. User submits email + password on `/login`
2. `POST /v1/auth/login` validates, returns `accessToken`, `refreshToken`, `user`
3. Tokens stored in `localStorage` (`accessToken`, `refreshToken`, `user`)
4. `apiFetch()` in `apps/*/src/lib/api.ts` attaches `Authorization: Bearer <token>` to every request
5. On 401: `apiFetch` tries refresh once (guarded by `isRefreshing` flag), then redirects to `/login` on failure — no retry loop
6. Forgot password: `POST /auth/forgot-password` → OtpToken in DB → email with `/reset-password?token=...` link → `POST /auth/reset-password`

---

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

---

## Internal Portal (`apps/internal`) — Implementation Status

All phases (1–13) + Waves 7–9 + v2 production test remediation complete. See `.planning/INTERNAL-PORTAL-V2-PLAN.md` for the full issue register.

### Security notes
- AI-generated HTML is sanitized with `DOMPurify` before render and before new-tab open (Blob URL)
- All AI preview iframes use `sandbox="allow-same-origin"`
- Free-text API fields (name, title, description) pass through `safeString` Zod transformer
- `SEED_ADMIN_PASSWORD` must be set in `packages/db/.env` — the seed throws if missing
- Auth token refresh is capped to 1 retry with an `isRefreshing` guard

### Forgot password flow
`POST /v1/auth/forgot-password` → creates OtpToken (1 hour TTL) → sends email with link → `POST /v1/auth/reset-password` validates token, updates password, invalidates all sessions.
Frontend: "Forgot password?" link on `/login` opens modal → `/reset-password?token=...` page handles the reset form.
