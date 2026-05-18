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

## ⚠️ WARNING: Linode source code is NOT a source of truth

The Linode server at `/opt/dashmani-platform` may contain **uncommitted, hand-edited code** that diverges from GitHub `main`. As of 2026-05-16 the server had 3 unpushed commits + ~106 file changes (a half-finished design migration that broke the Tailwind tokens and the UI).

**Rules:**
- **GitHub `main` is the only source of truth for code.** The deploy script does `git reset --hard origin/main`, which discards anything on the server that isn't in GitHub.
- **Never `rsync` from server → local.** It will overwrite your working tree with the server's broken/diverged state. If you need to compare, clone to a separate folder.
- **The production database, `.env` files, `uploads/`, and `.next/` build artifacts on the server are NOT in git** — they survive `git reset --hard` because they're untracked.
- If you find yourself wanting to "sync from the server", stop and back up the data instead (see "Data preservation" section in `.planning/`).

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

**Database changes are NEVER run by CI/CD.** If you change `schema.prisma`, SSH in manually after the deploy completes:
```bash
ssh linode
cd /opt/dashmani-platform
npm run db:generate && npm run db:push
```

> ⚠️ **Always diff before `db:push` on prod.** `prisma db push` will silently DROP columns the new schema doesn't define. Before running it, compare the prod table columns with `schema.prisma` to confirm the change is purely additive (CREATE TABLE / ADD COLUMN only).

### Deploy cycle (steady state)

1. Local branch → edit → `npm run dev` → test locally
2. PR → review → merge to `main`
3. GitHub Actions auto-deploys in ~3 min (`git reset --hard origin/main → npm install → turbo build → pm2 restart all`)
4. Verify: `curl https://api.digitalsukoon.com/v1/health` returns `{"success":true}`
5. **If `schema.prisma` changed:** SSH in and run `db:push` (with diff check above)

### Auth token behavior after a deploy

- **Access tokens** (4h, signed with `JWT_SECRET`): survive deploys as long as `JWT_SECRET` doesn't change.
- **Refresh tokens** (7d, signed with `JWT_REFRESH_SECRET`): survive deploys as long as `JWT_REFRESH_SECRET` doesn't change. Each is also stored hashed in the DB.
- **Refresh tokens include a `jti` (UUID nonce)** so two tokens issued in the same second for the same user don't collide on the `refresh_tokens.token` UNIQUE constraint. Don't remove the `jwtid` option in `signRefreshToken()` / `clientLogin` / `clientRefresh` / `acceptInvite`.

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
| `JWT_SECRET` | `change-me-in-production` | Change for production. Signs access tokens (4h) |
| `JWT_REFRESH_SECRET` | `change-me-in-production-refresh` | **Required** — signs refresh tokens (7d). Falls back to insecure `"dev-refresh-secret"` if missing |
| `SEED_ADMIN_PASSWORD` | `Admin@123456` | Password set for admin@digitalsukoon.com on seed |
| `INTERNAL_APP_URL` | `http://localhost:3000` | Used in reset-password email links |
| `HR_APP_URL` | `http://localhost:3002` | Used in HR notification emails |
| `SMTP_HOST` | `smtp.gmail.com` | Optional — emails no-op if SMTP_PASS missing |
| `SMTP_PORT` | `587` | Standard submission port; pairs with `SMTP_SECURE=false` (STARTTLS) |
| `SMTP_SECURE` | `false` | `false`=STARTTLS on 587, `true`=implicit TLS on 465. STARTTLS is the modern standard despite the name |
| `SMTP_USER` | `hr@digitalsukoon.com` | Gmail sender address — must match the Google account the App Password was generated under |
| `SMTP_PASS` | *(blank)* | Gmail **App Password** (16 chars, no spaces). Generate at Google Account → Security → 2-Step Verification → App passwords |

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

The reset-password handler reads `{ token, newPassword }` from the body (NOT `password` — that's a common mistake when testing with curl).

---

## Invite / Signup Flows

### Admin signup (internal portal)
1. Existing admin POSTs `/v1/admin/users/invite` with `{ email, roleIds?, designation? }` (requires `employees.create` permission)
2. Server creates `admin_invites` row, sends email containing the signup URL
3. New admin clicks link → lands on **`https://portal.digitalsukoon.com/admin-signup?token=<uuid>`** (locally: `http://localhost:3000/admin-signup?token=<uuid>`)
4. Frontend validates with `GET /v1/admin/users/invite/:token`
5. New admin submits name + password → `POST /v1/admin/users/accept-invite` → user row created, tokens issued, marked `usedAt`

### Client signup (client portal)
1. Existing admin POSTs `/v1/client/auth/invite-request` with `{ email }` (requires `clients.create` permission)
2. Server creates `client_invites` row. Email send currently not wired — only the response contains the token, admin forwards manually.
3. Client visits **`https://client.digitalsukoon.com/signup?token=<uuid>`** (locally: `http://localhost:3001/signup?token=<uuid>`) and submits `POST /v1/client/auth/register` with `{ token, password, contactName }` → client row created, tokens issued

### Reset password
Email link points to **`https://portal.digitalsukoon.com/reset-password?token=<uuid>`** (locally: `http://localhost:3000/reset-password?token=<uuid>`). Page submits `{ token, newPassword }` to `POST /v1/auth/reset-password`.

Both signup flows require their tables (`admin_invites`, `client_invites`) which were added to `schema.prisma`. If the DB schema doesn't match, the endpoint will 500 — run `db:push` after deploying schema changes.

---

## Deploy cycle (steady state)

The full GitHub→Linode pipeline is wired and self-sufficient as of 2026-05-18. Every push to `main` auto-deploys in ~3 min.

### Normal flow (code-only changes)

```bash
# 1. Local edit + test
git checkout -b feat/<name>
# ...make changes...
npm run dev   # verify locally
# 2. Push
git add . && git commit -m "..." && git push origin <branch>
# 3. Open PR → merge to main
# 4. Wait ~3 min — GitHub Actions runs scripts/deploy.sh on Linode:
#    git fetch + reset --hard + npm install + db:generate + turbo build + pm2 restart all
# 5. Verify
curl https://api.digitalsukoon.com/v1/health   # {"success":true}
```

### Schema-changing flow (when `schema.prisma` changed)

CI/CD never auto-runs `db:push` (intentional safety). After the deploy completes:

```bash
ssh linode
cd /opt/dashmani-platform
# Before running db:push, verify the diff is additive (no DROP COLUMN):
sudo -u postgres psql -d dashmani_prod -c "\d <table_you_changed>"
# Then sync:
npm run db:push
```

### One-time setup (already done, do NOT redo)

- Deploy SSH keypair `~/.ssh/dashmani_deploy` → public side in Linode `/root/.ssh/authorized_keys`
- GitHub secrets `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` set on the repo
- Linode's own `linode_ed25519` pubkey added as a GitHub Deploy Key (read-only) so `git fetch origin main` works from the server
- `/root/.ssh/config` on Linode pins `IdentityFile /root/.ssh/linode_ed25519` for `Host github.com`
- `/opt/dashmani-platform/.git` has `origin → git@github.com:dmpl6454/dashmani-platform.git`
- All `public.*` tables owned by `dashmani` DB user (so Prisma can ALTER them)

If you ever rotate any of those keys, the setup steps above are documented in `.planning/SAFE-DEPLOY-MIGRATION-PLAN.md`.

### Things that will break a deploy (and how to fix)

| Symptom | Cause | Fix |
|---|---|---|
| `bash: /opt/.../scripts/deploy.sh: No such file or directory` (exit 127) | Linode is on a commit that predates the script | Manual one-time `ssh linode && cd /opt/dashmani-platform && git fetch origin main && git reset --hard origin/main` |
| Build fails with `Property 'X' does not exist on type 'PrismaClient'` | `db:generate` didn't run after schema change | `deploy.sh` now runs it automatically — if you removed that step, add it back |
| Build fails with ESLint errors on production builds | All 4 `next.config.js` have `eslint: { ignoreDuringBuilds: true }` — don't remove it. Run `npm run lint` separately for code quality. |
| API crash-loops on `@esbuild/linux-x64 could not be found` | `npm install` skipped optional deps | `ssh linode && cd /opt/dashmani-platform && npm install esbuild --force && pm2 restart api` |
| `db:push` fails with `permission denied for table X` | Table is owned by `postgres` user, not `dashmani` | `ssh linode && sudo -u postgres psql -d dashmani_prod -c "ALTER TABLE X OWNER TO dashmani;"` |
