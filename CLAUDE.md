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
2. Overwrites `apps/*/.env.local` with `NEXT_PUBLIC_API_URL=https://api.digitalsukoon.com/v1` (see "Why `.env.local` is overwritten" below)
3. `npm install`
4. `npm run db:generate` (Prisma client)
5. `npx turbo build --concurrency=1` with `NODE_OPTIONS=--max-old-space-size=900` (sequential to manage 2GB RAM)
6. `pm2 restart all && pm2 save`

### Why `.env.local` is overwritten on every deploy

`NEXT_PUBLIC_*` env vars in Next.js are **baked into the JavaScript bundle at build time**. If `apps/*/.env.local` contains `NEXT_PUBLIC_API_URL=http://localhost:4000/v1`, the built bundle ships `localhost:4000` to every browser — and the browser tries to connect to `localhost:4000` **on the user's own machine**, which doesn't exist. Symptom: a vague "Load failed" error on the login page with no API request ever leaving the browser.

`.env.local` files are gitignored (as of 2026-05-18 — they were *accidentally tracked* before that, which is what caused the original outage). They don't come down with `git reset --hard`, so the deploy script overwrites them on every deploy with the production URL. Production is now self-healing even after a fresh server provision.

**Do not** add `.env.local` to git. Do not change this rewrite step without thinking through what happens when someone copies a localhost-pointing `.env.local` to the server.

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
| `apps/*/.env.local` | Next.js build (baked into JS bundle) | `NEXT_PUBLIC_API_URL` per frontend. **Gitignored.** Locally: `http://localhost:4000/v1`. In prod: `https://api.digitalsukoon.com/v1` — written automatically by `scripts/deploy.sh` on every deploy. |

All three `.env` files (root, api, db) need the same `DATABASE_URL` and `JWT_SECRET` values. The `.env.example` template works for all three.

> ⚠️ **`NEXT_PUBLIC_*` vars are baked into the JS bundle at build time** — changing `.env.local` after the build does nothing until you rebuild. The browser sees whatever value was in `.env.local` when `next build` ran. This is why the deploy script overwrites `.env.local` *before* running the build.

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
| `ANTHROPIC_API_KEY` | *(set locally)* | Required for AI features (Job Vacancy, Offer/Appointment/Employment docs, AI Chat in Internal portal; AI Presentation generator in HR portal). **Already set in `apps/api/.env` locally as of 2026-05-22.** Runtime-only — no rebuild needed. If the key is ever rotated on prod, refresh with: `ssh linode "grep ANTHROPIC_API_KEY /opt/dashmani-platform/apps/api/.env"`. |
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

## Portal hero / auth-page implementation method

When the user asks to redo the **hero / sign-in / sign-up page** for any portal (internal, client, hr, jobs, etc.), follow this method — the *design* changes, the *method* does not:

1. **Treat user-provided design files as prototypes, not literal code.** The user typically hands off an HTML/CSS/JS prototype (often as a `claude.ai/design` bundle — sometimes the response from `https://api.anthropic.com/v1/design/h/<hash>` is a gzipped tarball even when `WebFetch` reports it as "binary"; save the binary payload to `/tmp` and `tar -xzf` it). The tarball contains `<project>/project/*.html`, `<project>/chats/*.md`, and a `README.md` — read the README and the target HTML top-to-bottom, then **recreate the visuals in React/Tailwind inside the target Next.js app** — don't try to embed the prototype's React-via-CDN or Tailwind-via-CDN. Map design colors/fonts to the app's existing `tailwind.config.ts` tokens (`ink`, `indigo`, `sage`, `terra`, `action`, etc.) and only add new tokens (e.g. `sage.deep`) if the design needs a color the config doesn't have yet. If the design pulls in a new Google Font (e.g. `Instrument Serif` for italic display, `JetBrains Mono` for monospace), add it to both the `@import` line in `apps/<app>/src/app/globals.css` *and* a `fontFamily` token in `tailwind.config.ts` so it's available as a utility (`font-instr`, `font-mono-auth`, etc.).
2. **Preserve real functionality. No mock auth.** The form must call the existing `useAuth().login(email, password)` (or `apiFetch("/client/auth/register", ...)` for invite signup), keep the existing token storage keys (`accessToken`/`refreshToken`/`user` for internal, `clientAccessToken`/`clientRefreshToken`/`clientUser` for client), and keep the existing forgot-password modal wired to `POST /auth/forgot-password`. Strip any prototype affordance that isn't backed by the API: fake OAuth/Google/Microsoft/SSO buttons, fake "signup" tabs on internal portal (signup is invite-only via `/admin-signup?token=`), magic-link buttons we don't ship, etc. Replace them with honest copy ("Access is invite-only — email an admin").
3. **Keep route shape unchanged.** Internal portal sign-in stays at `/login`. Client portal: `/login` for sign-in, `/signup?token=<uuid>` for invite acceptance (the token-flow is required — render an "Invalid invite link" state when token is missing). Don't introduce new auth routes.
4. **Extract shared field/styles to `src/components/auth/shared.tsx`** in each app when the design's auth components (input field, animations, paper card, aurora background) are reused across login and signup. Never `import` from one `page.tsx` into another `page.tsx` — that crosses Next.js route boundaries. **⚠️ CRITICAL: The `shared.tsx` file MUST be staged in git** — it's a module dependency of the auth pages. If login/reset-password pages import from it, it must be committed, or the build will fail on deploy with "Module not found: Can't resolve '@/components/auth/shared'".
5. **Page-scoped CSS via styled-jsx (`<style jsx global>`)** for animations/keyframes specific to the auth page (aurora drift, dot-grid, marquee, paper texture). Don't pollute `globals.css` with auth-only styles.
6. **Dynamic content must be real, not gibberish.** If the design has a "live ops" panel or live data, either wire it to a real endpoint (with graceful fallback) or use clearly-labelled placeholder stats that age gracefully. The live clock should use `new Date()` in a `useEffect` (avoid SSR hydration mismatch — initialize state to `null` and set it in `useEffect`). Activity tickers can use a static seed list rotating on a timer.
7. **Accessibility & motion:** keep `aria-live="polite"` on submit buttons, `aria-invalid` / `aria-describedby` on fields, and respect `prefers-reduced-motion` (kill aurora/float/dot-pulse animations under that media query).
8. **Verify before declaring done:** `npx tsc --noEmit -p apps/<app>/tsconfig.json` AND `npm run build -w @dashmani/<app>` must both pass. The login page is what users hit first — a broken build here means everyone is locked out. **Do a full `npm run build` (all apps), not just the one app** — auth pages may import shared components that only get caught by the full build.
9. **Production = localhost:** the auth page reads `NEXT_PUBLIC_API_URL` from `apps/<app>/.env.local` like the rest of the app — no special handling. Deploy script's `.env.local` overwrite (see deploy section) covers prod.

Why this method exists: hero pages are the most visible surface, the most tempting place to put fake "wow" affordances, and the easiest place to accidentally regress real auth. The rule is: **design the surface, preserve the wire.**

## Key Conventions

- API versioning prefix: `/v1/`
- Shared Zod schemas in `packages/shared/src/validators/` are used on both API (input validation) and frontends (form validation) — don't duplicate validators in app code.
- Use `safeString` from `packages/shared/src/utils/sanitize.ts` instead of `z.string()` for any free-text user input field (name, title, description, etc.) — strips HTML tags at the API boundary.
- Use `formatStatus()` from `packages/shared/src/utils/status.ts` whenever displaying enum status values in the UI — converts `UPPER_SNAKE_CASE` to "Title Case".
- Cron jobs live in `apps/api/src/cron/` and are bootstrapped in `src/index.ts`.
- Business logic belongs in `apps/api/src/services/`, not in route handlers.
- **Public API endpoints must never expose internal user UUIDs.** `GET /v1/jobs` and `GET /v1/jobs/:id` use `getActiveJobListings()` and `getPublicJobListingById()` in `job-listing.service.ts` — both use explicit Prisma `select` to strip `createdBy`/`createdById`. If you add new public endpoints, always use `select` rather than returning full model rows.
- **Working week is Monday–Saturday — Sunday is the only weekend day.** Any weekend / working-day calculation must use `dayOfWeek === 0` (Sunday only), never `=== 0 || === 6`. Affects calendar visualization (`getCalendarData()` in `holiday.service.ts`), attendance denominator (`/hr/attendance`), and any future submission-rate / non-submitter / leaderboard logic that excludes weekend days. Confirmed by user 2026-05-22.
- **Per-portal auth token storage keys** — internal: `accessToken`, HR: `hrAccessToken`, client: `clientAccessToken`. Each portal's `src/lib/api.ts` reads its own key. **Never define a local `apiFetch` in a page file** — copy-pasted helpers reading the wrong key (e.g. `accessToken` in HR) silently send no Authorization header and surface as "Missing or invalid authorization header". Always `import { apiFetch } from "@/lib/api"`.
- **All "today" date computations must use IST (UTC+5:30), never UTC.** `new Date().toISOString().split("T")[0]` returns the UTC date, which is wrong between 12:00 AM and 5:30 AM IST (UTC has flipped to the next calendar day, IST hasn't). The fix: backend uses `todayIST()` / `istMidnight()` / `dateToIST()` from [packages/shared/src/utils/date.ts](packages/shared/src/utils/date.ts). Frontend uses `d.getFullYear()`/`getMonth()`/`getDate()` (browser local time, already IST for all users in India) — **never** `d.toISOString().split("T")[0]` for date-key writes. Affects daily reports, attendance, POA, leaderboard, account growth snapshots, analytics trend grouping, offer/appointment letter dates, and every cross-day duplicate check. Comprehensive IST fix shipped 2026-05-30 (commits `d2da1a7`, `c0a2feb`).
- **`apps/jobs` is the ONLY public, SEO-dependent portal — its public pages MUST render job data server-side.** The other four portals are auth-gated SPAs where client-side fetching is correct; the jobs portal is the opposite. If the homepage or job-detail pages fetch jobs in the browser (`"use client"` + `useEffect`/`useSWR`), Googlebot receives an empty `0 positions / Loading…` shell and indexes nothing — the portal goes invisible on Google. **The required pattern (shipped PR #29, commit `3720554`, 2026-06-06):** `page.tsx` files in `apps/jobs/src/app/` and `[id]/` are **Server Components** (no `"use client"`) that fetch via `getJobs()`/`getJob()` from [apps/jobs/src/lib/jobs.ts](apps/jobs/src/lib/jobs.ts) and seed the interactive client components (`JobsClient.tsx`, `[id]/JobDetailClient.tsx`) — homepage via SWR `fallbackData`, detail via `initialJob`. Rules: (1) each job page **self-canonicalizes** via `generateMetadata` → `alternates.canonical`; **never** add a hardcoded `<link rel="canonical">` to `layout.tsx` (it overrides every page and makes Google treat all jobs as homepage duplicates). (2) All JSON-LD `<script>` payloads go through `safeJsonLd()` (escapes `<` → `<` so a description can't break out of the `<script>` — the correct answer to the `dangerouslySetInnerHTML` security-hook warning, not DOMPurify). (3) Bad job IDs → `notFound()` (real 404, not a soft-404 200). (4) Any client child using `useSearchParams()` needs a `<Suspense>` boundary once the page statically prerenders, and its fallback must render **real content, not a spinner**. (5) Gate loading placeholders on `isLoading && jobs.length === 0`, never bare `isLoading`. (6) **The homepage `<title>` is brand-only by design.** It lives in `metadata.title.default` in [apps/jobs/src/app/layout.tsx](apps/jobs/src/app/layout.tsx) (currently `"Careers at Digital Sukoon — Jobs & Internships"`) — Google crawls that `<title>` *verbatim*, so it's the exact string shown in search results. Detail pages override it via the `template` (`"%s | Digital Sukoon Careers"`). Keep the parent-company name **"Dashmani Media Private Limited" out of every visitor-facing string** (title, OpenGraph/Twitter titles, footer copyright → all read "Digital Sukoon"), but **keep it in the hidden/structured fields** — JSON-LD `legalName`/`publisher` (schema.org `legalName` = the registered entity behind the brand; Google Jobs uses it to verify the employer — removing it weakens `JobPosting` trust), plus the `keywords`/`description` meta tags (hidden; help rank for "Dashmani Media jobs" searches). A title/footer string can **never** change the URL — that's DNS (`jobs.digitalsukoon.com`). **Verify changes by fetching the LIVE/built HTML as a Googlebot UA and confirming job titles + `JobPosting` JSON-LD are in the raw HTML with no visible "Loading…".** Each role + the listing page emit schema.org `JobPosting`/`ItemList` for Google Jobs eligibility. **Do not "simplify" these back to client-fetch SPAs — it re-breaks indexing.**

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
6. Forgot password (all three portals — internal, hr, client):
   - Internal: `POST /v1/auth/forgot-password` → OtpToken with `userId` → email with `/reset-password?token=...` link → `POST /v1/auth/reset-password`. The HR portal calls the same endpoint with `{ app: "hr" }` so the email link points at `HR_APP_URL` instead of `INTERNAL_APP_URL`.
   - Client: `POST /v1/client/auth/forgot-password` → OtpToken with `clientId` (added 2026-05-18, nullable userId + nullable clientId on `otp_tokens`) → email with `/reset-password?token=...` link → `POST /v1/client/auth/reset-password`.
   - For non-ACTIVE users (ONBOARDING / INACTIVE), `forgotPassword` deliberately does NOT issue a reset link — it sends an explanation email instead. A reset wouldn't unlock login for those statuses; sending one anyway is how users get into the "I reset my password but still can't log in" loop. The HTTP response is still the opaque "if-exists" envelope.

### Email-case lockouts — never re-introduce

Postgres unique constraints on `email` are case-**sensitive**. If `User.email` is stored as `Foo@x.com` but the user types `foo@x.com`, `findUnique` returns `null` and they see `INVALID_CREDENTIALS` with no recovery path. To prevent this we **always normalize emails** (trim + lowercase) at every write/lookup boundary:

- Validators in `packages/shared/src/validators/*` use the `normalizedEmail` Zod schema from [packages/shared/src/utils/sanitize.ts](packages/shared/src/utils/sanitize.ts). When in doubt, use `normalizedEmail` not `z.string().email()`.
- Service-layer functions also call `.trim().toLowerCase()` defensively — don't trust upstream callers.
- HR's `identifier` (email-or-phone) goes through `normalizeIdentifier()` which lowercases only when `@` is present.
- **The DB query itself must be case-insensitive, not just the input.** Pre-existing mixed-case rows survive even after the input is normalized. All three auth services (`auth.service.ts`, `hr-auth.service.ts`, `client-auth.service.ts`) use `findFirst({ where: { email: { equals: x, mode: "insensitive" } } })` — never plain `findUnique({ where: { email: x } })` on user-supplied email. **If you add a new auth code path, copy this pattern.** A 2026-05-21 regression hit Diksha because `hr-auth.service.ts` was still doing exact-match while the input was normalized — silent miss.
- One-time DB backfill: [packages/db/prisma/normalize-emails.ts](packages/db/prisma/normalize-emails.ts) lowercases existing mixed-case rows. Safe to re-run; reports collisions without writing if any rows would conflict. **Last run on prod: 2026-05-21** — 4 users normalized, 2 collision pairs flagged for manual resolution (see [.planning/AUTH-LOCKOUT-FIXES.md](.planning/AUTH-LOCKOUT-FIXES.md)).

### HR self-register vs admin-invite collision — handled

A user who self-registers at `POST /v1/hr/auth/register` is created with `status: "ONBOARDING"`. If an admin then invites the same email via `POST /v1/admin/users/invite`, the endpoint detects the existing pending row and **promotes it to ACTIVE** with the requested roles/designation rather than 409'ing. This closes the trap where a user was "registered" but admin had no way to unblock them through the invite flow.

See [.planning/AUTH-LOCKOUT-FIXES.md](.planning/AUTH-LOCKOUT-FIXES.md) for the full lockout-trap matrix and how each one was closed.

---

## Client Portal (`apps/client`) — Implementation Status

All 9 implementation phases + 5-wave audit remediation complete + TC-191 (forgot-password) verified implemented. See `.planning/CLIENT-PORTAL-AUDIT.md` for the full issue register. The `/login` page has a `forgotOpen` state that opens a `ForgotPasswordModal` calling `POST /client/auth/forgot-password`; `apps/client/src/app/reset-password/` page handles the token-based reset flow calling `POST /client/auth/reset-password`.

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

All phases (1–13) + Waves 7–9 + v2 production test remediation complete. See `.planning/PORTAL-TEST-FINAL-V2-PLAN.md` for the full issue register (updated 2026-05-19).

### What was fixed in the 2026-05-19 remediation pass

**API service mismatches (admin-features.routes.ts):** 5 routes were calling service functions with wrong names or signatures — `listSalarySlips`, `generateBulkSalarySlips` (positional args), `getOfferLetters` (positional), `listContracts`, `listHolidays` — all fixed. `getContractById` was also added to `employment-contract.service.ts` (was missing but called from hr-features).

**HR routes:** `creator:` → `createdBy:` in Task include; `content:` → `body:` in TaskComment create (both match Prisma schema).

**XSS fix:** `content/[id]/page.tsx` — `innerHTML` with user-controlled URL replaced with safe DOM API (`createElement` + `textContent`).

**Missing pages:** `/settings` (profile + change-password) and `/clients/[id]` (client detail + edit + delete + invite + projects) created.

**formatStatus():** Applied across 10+ pages that were rendering raw `UPPER_SNAKE_CASE` enum values.

**Jobs UUID leak (P0 security):** `GET /v1/jobs` and `GET /v1/jobs/:id` public endpoints no longer expose internal `createdBy`/`createdById` UUIDs — both use explicit `select` in the service.

**Missing HR portal endpoints:** `/hr/profile` (GET+PUT), `/hr/reports/today`, `/hr/reports` (GET+POST), `/hr/accounts`, `/hr/leaderboard`, `/hr/team`, `/hr/notifications` (GET+count+mark-read+read-all) all added to `hr-features.routes.ts`.

### What was added in the 2026-05-19 dashboard/reports/teams overhaul

**Dashboard:** Extended to 11 stat cards (added Links Today, Links/Month, Submitted Today + submission rate). "Links Activity" bento section with recharts BarChart, customisable date-range (14d/30d/90d + custom picker). **Quick Assign Account** bento card — opens `QuickAssignModal`, employee-first flow to assign social accounts directly from dashboard without navigating to `/accounts`.

**Employee reports (`/reports/[employeeId]`):** Full stats strip (Total Reports, Total Links, Current Streak, Avg Links/Day, Submission Rate), 30-day BarChart, platform breakdown, date-range filter on the reports list below.

**Links analytics (`/reports/links`):** New page — daily AreaChart, weekly BarChart, growth rate vs prior period, platform breakdown, team ranks, top submitters, non-submitters.

**Reports summary (`/reports`):** Added 3 columns (Avg/Day, Streak, Last Submitted). "Links Analytics" button in header.

**Teams:** Bulk delete (checkboxes + action bar), move/remove member actions on each member row, inline duplicate-name 409 error.

**Employees:** Active/Archived tab toggle — `includeDeleted` API param shows soft-deleted employees in Archived view.

**Cascade deletes:** Prisma schema updated — all employee-owned data (Attendance, LeaveRequest, DailyReport, SalarySlip, EmploymentContract, OfferLetter, etc.) now has `onDelete: Cascade`; `AuditLog` intentionally kept `onDelete: Restrict` for compliance. ⚠️ **`db:push` required on Linode after deploy** — FK constraints only, no column drops.

### Still open (known remaining issues)

- **F-TOKEN-STORAGE (deferred XL):** Auth tokens still in `localStorage` — httpOnly cookie migration is 1+ week, high blast radius across all 4 portals + API. Explicitly deferred per user decision 2026-05-21.
- **F-RESPONSIVE-ALL-PORTALS (deferred XL):** Full 375px responsive sweep for Internal + HR. Deferred — internal portal is primarily desktop-used; mobile sidebars already work via hamburger drawers.
- **Link engagement metrics — YouTube shipped 2026-05-30, Instagram/Facebook pending OAuth build.** `link_metrics` table + 6h cron polls all YouTube links in `report_links` (last 60 days). Views/likes/comments visible in Internal /reports (5th stat card + Top YouTube Links panel) and HR /report (insights panel below form). Provider pattern in `apps/api/src/services/social-insights/` — instagram.provider.ts and facebook.provider.ts are stubs ready for when OAuth flow is built. `getSupportedInsightPlatforms()` in packages/shared is the single switch. **Pending UX:** Top YouTube Links panel only shows view count — likes/comments columns and "All time" window option not yet added.

### Audited and confirmed resolved (2026-05-22)

These were previously listed as P0/P1 open but are in fact already shipped — kept here so we don't re-open them by mistake:

- **F-LEAVE-TZ-BUG:** Mitigated. Form sends `YYYY-MM-DD` ISO string; [apps/api/src/services/leave.service.ts](apps/api/src/services/leave.service.ts) parses with `setHours(0,0,0,0)` — no IST→UTC day shift.
- **Employee count mismatch (#9/#71 "78 Active vs 50 total"):** Fixed. `employeeWhere` filter defined once at the top of [apps/api/src/services/analytics.service.ts](apps/api/src/services/analytics.service.ts) and used for all employee counts. (See "Employee vs Admin distinction" section below for the convention.)
- **Self-approval of leave (#22/#66):** Fixed. `leave.service.ts:82-102` throws 403 if `leaveReq.employeeId === approvedBy`; same guard on reject path.
- **UTM params exposed in account names (#36):** Fixed. `sanitizeAccountHandle()` in [packages/shared/src/utils/sanitize.ts](packages/shared/src/utils/sanitize.ts) strips query strings via `.split("?")[0]`; called defensively in `account.service.ts` on all handle writes.
- **No destructive confirm on job delete (#48):** Fixed. `ConfirmDialog` wired in [apps/internal/src/app/jobs/page.tsx](apps/internal/src/app/jobs/page.tsx) with `deleteJobId` state.
- **Password autocomplete (#59):** Fixed where it matters. Internal + HR login fields have `autoComplete="current-password"`. Admin add-employee form would still benefit from `autocomplete="new-password"` if/when that form is revisited.
- **Client portal mobile + cadence chart (BUG-23/BUG-20):** Both shipped — see "Fixed since last update" below.

### Known limitations / pending UX work

- **Salary slips flow (shipped 2026-05-23, commit `a498d3e`):** All 6 issues from `.planning/SALARY-SLIPS-FIX-PLAN.md` resolved. Field-name bugs fixed (`slip.basicSalary`, `slip.employee.name`). Search now filters by employee name/email (250ms debounce). AI Assistant tab replaced with `SalarySlipGenerator` (form → AI preview → Send to Employee, matching Offer/Contract/Appointment pattern); auto-prefills salary breakdown from `profile.salary`. Edit modal on `/salary-slips` with all 11 fields + live net-salary + inline errors; blocks approved slips. `PUT /admin/salary-slips/:id` and `POST /admin/ai/salary-slip/preview` added. No `db:push` required. HR portal employee view already worked and was untouched.

- **HR daily report — "links submitted today" visibility:** The read-only "Submitted today" panel is shipped (already above the form). The `POST /hr/reports` delete-and-recreate semantics in [daily-report.service.ts](apps/api/src/services/daily-report.service.ts) are intentionally left untouched (load-bearing for the org).

- **HR daily report — auto-dedupe + per-row validation (shipped 2026-05-30):** Three interlocking improvements to [apps/hr/src/app/report/page.tsx](apps/hr/src/app/report/page.tsx): (1) **In-submission auto-dedupe** — an `useEffect` detects duplicate URLs across rows in real time (covers both Smart Paste and manual row-by-row entry), silently removes subsequent occurrences keeping the first, shows a green toast "N duplicate links removed". (2) **Cross-day auto-dedupe** — on load and after every submit, `GET /hr/reports/my-link-urls?days=60` returns a `{url→date}` map of the employee's prior links (today excluded); any URL already submitted on a previous day is auto-removed with a toast noting the date. (3) **Per-row + per-field validation errors** — `ApiError` class added to [apps/hr/src/lib/api.ts](apps/hr/src/lib/api.ts) preserves `error.details` from the API; on submit failure the form maps `details[{field:"links.3.url"}]` to per-row red borders + inline messages + auto-scroll to the first offending row. The server-side `DUPLICATE_LINKS` guard in the service is kept as defence-in-depth. `AppError` extended with optional `details: Array<{field,message}>` so service errors can also surface structured info. No `db:push` required.

- **YouTube insights UI — columns and window (planned):** Top YouTube Links panel on /reports and /reports/links currently shows URL + employee name + view count only. Likes and comments columns not shown. Panel only follows the active window pill (no "All time" option). Both are easy additions — just needs a layout decision on the table.

### Fixed since last update (2026-05-21 / 2026-05-22)
- **F-WORKLOAD-COLUMNS:** Critical/High cells now render `—` when 0 — `tasksByPriority?.critical ?? 0` guard added.
- **Mobile sidebar — HR + Internal:** Both portals now have `hidden lg:flex` desktop aside + fixed mobile topbar (h-14/h-[57px], z-40) with hamburger + full-height overlay drawer (z-50). Close on route change. `pt-14 lg:pt-0` on `<main>` clears the fixed bar. Client portal already had this pattern.
- **F-NAV-RESTRUCTURE (Card 4.2):** Internal sidebar restructured — Analytics/Workload/Expenses/Devices/Complaints/Bug Reports/AI Assistant pulled out of "More" into named sections ("Analytics", "Tools"). "More" now contains only rarely-used items.
- **F-NAV-LABELS (Card 4.3):** HR sidebar already had full labels ("Leaderboard", "Plan of Action") — no change needed.
- **F-CLIENT-PERF (Card 4.5):** Client portal SWR polling overhauled — removed 60s `refreshInterval` from analytics hook; added `revalidateOnFocus: false` + `dedupingInterval` to all heavy client hooks (analytics: 300s, projects: 120s, content/files: 60s).
- **Wave 5 cleanup script:** `scripts/cleanup-production.ts` written. Dry-run safe by default. Run from `packages/db/`: `npx tsx ../../scripts/cleanup-production.ts`. Covers all 17 production cleanup operations. Requires `--apply --confirm-prod` flags to write anything.
- **F-PLATFORM-SHORTCUT:** Top-nav search button now shows `⌘K` on Mac and `Ctrl K` on Windows/Linux — detected via `navigator.platform` in a `useEffect`.
- **F-CLIENT-HOWITWORKS-STATS:** Client portal login "How it works" section no longer shows hardcoded `0` / `6h` / `24` values — replaced with honest non-numeric copy.
- **TC-186 F-SOP-DB-BACKED (2026-05-22):** SOP sections no longer hardcoded. `system_settings` DB table added (additive). `GET /admin/sop-content` returns stored sections; `PUT /admin/sop-content` lets admins update them. HR portal fetches on load and falls back to default content if none is stored. ⚠️ **`db:push` required on Linode after this deploy.**
- **BUG-20 F-CLIENT-CADENCE-DATA (2026-05-22):** Publishing cadence chart on client analytics now uses real `weeklyPosts` data from `getClientContentAnalytics()` — last 5 weeks of published-post counts. `ClientAnalytics` type updated accordingly.
- **Reset-password TTL extended to 24h (2026-05-22):** `auth.service.ts` and `client-auth.service.ts` reset tokens now expire in 24h (was 1h). Triggered by Fareen Sabir missing back-to-back links (email delivered but TTL expired before she clicked). Email copy and all three forgot-password modal success messages updated to say 24h and prompt spam-folder check.
- **deploy.sh: nuke .next/ before build (2026-05-22):** `scripts/deploy.sh` now wipes `apps/*/.next` before every `turbo build`. Fixes intermittent `ENOENT: .../page.js.nft.json` crash in Next.js 14's `collectBuildTraces` step caused by stale partial caches from prior OOM-killed builds.
- **Jobs portal redesign (PR #10, 2026-05-22):** `apps/jobs` fully redesigned — editorial layout on listing page, rich detail panel with dept colors, apply form with file upload, toast notifications, keyboard navigation, prefers-reduced-motion, next/font (no render-blocking @import), `DEPT_COLORS` extracted to `apps/jobs/src/lib/dept-colors.ts`. All PR review critical issues resolved in follow-up commit before merge.
- **Jobs portal SEO / server-rendering (PR #29, commit `3720554`, 2026-06-06):** The portal wasn't appearing on Google because its public pages were client-rendered — Googlebot got an empty `0 positions / Loading…` shell with no job content. Fixed by converting the homepage and `[id]` detail pages to **Server Components** that fetch jobs server-side and seed the existing interactive client UI (renamed to `JobsClient.tsx` / `[id]/JobDetailClient.tsx`). Added [apps/jobs/src/lib/jobs.ts](apps/jobs/src/lib/jobs.ts) (`getJobs`/`getJob` ISR, `buildJobPostingSchema`, `safeJsonLd`), per-job `generateMetadata` (unique title + **self-canonical**), `generateStaticParams`, per-role + `ItemList` `JobPosting` JSON-LD (Google Jobs eligibility), and `notFound()` for bad IDs. Removed the hardcoded `<link rel="canonical">` from `layout.tsx` that was making every job a homepage duplicate. **Verified 12/12 against live prod as Googlebot.** See the `apps/jobs is the ONLY public SEO-dependent portal` rule in Key Conventions above for the architecture that must be preserved. **Google Search Console (one-time, done 2026-06-06):** verified a **Domain property** `digitalsukoon.com` via Cloudflare auto-DNS (covers all subdomains), submitted `https://jobs.digitalsukoon.com/sitemap.xml`, requested indexing for all 5 URLs. **New jobs need NO repeat GSC work** — the sitemap auto-generates from live jobs (hourly revalidate), so Google discovers new roles on its own; per-job Request-Indexing is optional (only to speed a fresh role from ~days to ~1 day). Full guide: [.planning/JOBS-SEO-AND-GSC-GUIDE.md](.planning/JOBS-SEO-AND-GSC-GUIDE.md). Frontend-only, no `db:push`.
- **Jobs homepage title — dropped parent-company name (PR #31, 2026-06-10):** Google was showing `"Careers at Digital Sukoon | Dashmani Media — Jobs …"`; user wanted brand-only. Root cause: the `<title>` is hardcoded in `metadata.title.default` in [apps/jobs/src/app/layout.tsx](apps/jobs/src/app/layout.tsx) and Google crawls it verbatim (it wasn't appending the name). Changed all **visitor-facing** strings to `"Careers at Digital Sukoon — Jobs & Internships"`: the `<title>` default, OpenGraph title, Twitter title, and the footer copyright (`© Digital Sukoon`, was `Dashmani Media Private Limited`). **Deliberately kept** "Dashmani Media Private Limited" in JSON-LD `legalName`/`publisher` (schema.org's field for the registered entity behind a brand — Google Jobs uses it to verify the employer) and in the hidden `keywords`/`description` meta tags (help rank for "Dashmani Media jobs" searches; never rendered). The URL is DNS-controlled (`jobs.digitalsukoon.com`) and a title can't touch it. Verified: `tsc` clean, full `npm run build -w @dashmani/jobs` passes, built `index.html` `<title>` confirmed brand-only. Google reflects the new title only after it **recrawls** (days–2 weeks; nudge via GSC URL Inspection → Request Indexing). See Key Conventions rule (6) on the jobs portal. Frontend-only, no `db:push`. **General SEO setup playbook for any project: [.planning/SEO-SETUP-PLAYBOOK.md](.planning/SEO-SETUP-PLAYBOOK.md).**
- **Portal fixes batch (2026-05-22):** 9 issues from `.planning/PORTAL-FIXES-PLAN-2026-05-22.md` implemented — see plan file for full status. Key items: `dispatchNotification()` routing matrix (Issue 1 partial), jobs portal contact block (Issue 2), leaderboard admin filter (Issue 3), `countTeams()` helper (Issue 5), employee edit 400 fix (Issue 6), task/content required fields on create (Issue 8), internship sticky modal + header fix (Issue 11), scroll-to-top on report detail (Issue 12), Leave page + sidebar entry (Issue 13). All TypeScript checks pass.
- **Follower sync fixes (2026-05-23, commit `b40b142`):** YouTube scraper was returning the wrong channel's count — `subscriberCountText` always matched a sidebar "related channels" entry first. Fixed by matching `accessibilityLabel` containing "subscribers", which is unique to the channel's own header. Facebook mbasic.facebook.com returns HTTP 400 without a session; switched to `www.facebook.com` with Googlebot UA + og:description parsing with Devanagari numeral decoding (Indian-localised pages encode follower counts in Hindi digits). TikTok/LinkedIn/Twitter scrapers removed — TikTok is a client-rendered SPA, LinkedIn returns HTTP 999 on bot UAs, nitter mirrors are dead. Those platforms now use manual entry via a per-row pencil icon on the accounts page. Added `GET /accounts/sync-followers/status` progress endpoint; sync button now shows live `"Syncing X/Y…"` and an indigo banner with running totals (updated/failed/skipped). No `db:push` required.
- **HR portal batch (2026-05-22 evening, commit `0cc2f21`):** Six end-user-reported issues + two follow-ups. (1) Expense claim `Missing or invalid authorization header` — [apps/hr/src/app/expenses/page.tsx](apps/hr/src/app/expenses/page.tsx) had a local `apiFetch` reading `accessToken` instead of `hrAccessToken`; replaced with shared `@/lib/api` import. (2) Upload Document UI alignment — added invisible label spacer above the Upload button in [apps/hr/src/app/documents/page.tsx](apps/hr/src/app/documents/page.tsx) so all 3 grid cells share the same baseline. (3) PPT/AI Presentation `Missing or invalid authorization header` — same root cause as #1 in [apps/hr/src/app/presentations/page.tsx](apps/hr/src/app/presentations/page.tsx); fixed both `apiFetch` (now shared) and `apiFetchRaw` (now reads `hrAccessToken`). (4) Plan of Action policy — locked to today only; past dates are read-only with a "Past — view only" badge; forward navigation removed; Save button hidden when `!isToday`. See [apps/hr/src/app/plan/page.tsx](apps/hr/src/app/plan/page.tsx). (5) Calendar leave clarity — [holiday.service.ts](apps/api/src/services/holiday.service.ts) now returns `leaveStatus` for APPROVED / PENDING / REJECTED; [apps/hr/src/app/calendar/page.tsx](apps/hr/src/app/calendar/page.tsx) colour-codes accordingly (approved=indigo, pending=amber+"Pending" label, rejected=red+strikethrough+"Rejected" label) and legend lists all 3 states. (6) **Contract not visible to employee — root cause was an orphaned save endpoint.** The AI Assistant `ContractGenerator` was calling `POST /admin/ai/generate-contract` (HTML preview only) but never `POST /admin/contracts` (the actual save). Added a green **Send to Employee** button + warning banner in [apps/internal/src/app/ai-assistant/page.tsx](apps/internal/src/app/ai-assistant/page.tsx) `ContractGenerator` that POSTs the structured payload (`employeeId`, `contractDate`, `designation`, `department`, `salary`, `probationMonths`, `noticePeriod`) after preview. Employees can now see and sign contracts under `/contract` in the HR portal. **The Offer Letter and Appointment Letter generators likely have the same pattern — verify before treating any "employee can't see my offer letter" report as a new bug.** (F-U-1) Working week is Mon–Sat — see Key Conventions; affects `holiday.service.ts` and `/hr/attendance`. (F-U-2) Attendance card hidden for non-employee accounts — `/hr/attendance` now queries `userRoles`, returns `{ isEmployee: false }` if all roles are Super Admin / Admin; [apps/hr/src/app/dashboard/page.tsx](apps/hr/src/app/dashboard/page.tsx) omits both the attendance stat card and the bento block when `isEmployee !== true`. Build clean, all 5 apps. No `db:push` required.
- **Batch 2026-05-23 (open-issues sweep):** (1) **Offer Letter "Send to Employee"** — `OfferLetterGenerator` in [apps/internal/src/app/ai-assistant/page.tsx](apps/internal/src/app/ai-assistant/page.tsx) now has a green **Send to Employee** button that POSTs to `POST /admin/offer-letters` after preview; same amber warning banner pattern as Contract generator. (2) **Appointment Letter "Send to Employee"** — `AppointmentGenerator` now has the same pattern; stored as an `OfferLetter` row with `letterType: "APPOINTMENT"`. `offer_letters` schema extended with `letterType` (default `"OFFER"`) and `noticePeriod` columns (additive). `generateOfferLetterSchema` updated with `letterType` + `noticePeriod` optional fields. ⚠️ **`db:push` required on Linode after this deploy.** (3) **"Keep me signed in" dead checkbox removed** from [apps/internal/src/app/login/page.tsx](apps/internal/src/app/login/page.tsx) — was never wired; removed rather than build a dummy affordance. (4) **AssignModal createPortal** — already using `ModalPortal` component (which wraps `createPortal`). No change needed; confirmed resolved. (5) **Internal portal notification bell** — already fully built in [apps/internal/src/components/top-nav.tsx](apps/internal/src/components/top-nav.tsx) with Bell icon, unread count badge, drop-down panel, mark-all-read; confirmed resolved. (6) **HR password strength meter** — already blocks submission when `score < 2` via the `if (Object.keys(next).length) return` guard in `handleRegister`; confirmed resolved. (7) **Job applications admin visibility** — `POST /jobs/:id/apply` creates a `JobApplication` row via `submitApplication()`; admin page defaults to `"applications"` view tab with SWR key `/admin/applications`; confirmed fully wired. (8) **Issues 10+14 (schema)** — `Announcement.orgUnitId` and `LeaveRequest.attachment*` already present in `schema.prisma`; confirmed no further work needed. TypeScript clean on all apps.
- **Portal batch (2026-05-23):** (1) **HR Presentations full-screen escape** — editor/preview modes previously used `min-h-screen` divs that broke out of PortalShell hiding the sidebar; fixed to `flex-1/flex-col` layout. (2) **Employee detail page UX overhaul** ([apps/internal/src/app/employees/[id]/page.tsx](apps/internal/src/app/employees/[id]/page.tsx)) — all `alert()` calls replaced with inline red/green banners (error auto-clears 6s, success 4s); form stays on page after save + shows "✓ Saved" + calls `mutateEmployee()`/`mutateProfile()`; RoleManager shows inline error text instead of `alert()`. (3) **Employee form profile-data save** ([apps/internal/src/components/employee-form.tsx](apps/internal/src/components/employee-form.tsx)) — designation/salary/joinDate were silently dropped on update (stripped by validator); form now makes a second `PUT /admin/employees/:id/profile-data` call; pre-populated from async `profileData` fetch. (4) **`PUT /admin/employees/:id/profile-data` added** to [apps/api/src/routes/admin-features.routes.ts](apps/api/src/routes/admin-features.routes.ts) — upserts `EmployeeProfile` (was missing; frontend calls were 404ing). (5) **Role pills not highlighting** — fixed in both Edit Employee form and RoleManager (shape was `r.role.id` not `r.id`). (6) **Header role badges blank** — same nested shape fix. (7) **Status field added to Edit Employee** — admins can reactivate inactive employees. (8) **Reactivation clears `deletedAt`**. (9) **`updateEmployee findFirst`** no longer blocks archived employees. (10) **Deactivate/archive blocked when active channel assignments exist** — guard in 3 code paths. (11) **Zero-role guard** in RoleManager, EmployeeForm, `updateEmployee`, and `PUT /admin/users/:id/roles`. (12) **SOP page 401** — `/hr/sop-content` endpoint now uses the correct HR auth middleware. (13) **Offer letter + contract PDF downloads** now use `apiFetch`/`apiFetchRaw` instead of raw `fetch`, so the token refresh flow applies and 401s after expiry are resolved. No `db:push` required.
- **Final pending issues batch (2026-05-23, commit `48f5542`):** All 7 issues from `.planning/FINAL-PENDING-ISSUES-2026-05-23.md` resolved. (1) **Accounts By Employee search** — employee-name search input added above the By Employee cards grid with empty-state. (2) **Announcements modal** — `items-end sm:items-center` → `items-center` so recipient selector is always in view. (3) **Dashboard QuickAnnounceModal recipient selector** — team dropdown + conditional `orgUnitId` in POST body; confirm screen text reflects selected team vs "all". (4) **Reports lag fixed** — removed 30s/60s SWR `refreshInterval` from `use-reports.ts`; replaced with `revalidateOnFocus: false` + `dedupingInterval: 60_000`; memoized daily/weekly chart transforms; `LinkPreviewCard` now gates OG-fetch behind `IntersectionObserver` (200px root margin). (5) **TASK_ASSIGNED notification** — `TASK_ASSIGNED` added to `NotificationType` enum in schema; routing entry added (`RECIPIENT`); `createTask` and `updateTask` (new assignee only) fire `dispatchNotification` after save. (6) **AI Assistant audit** — all generators (Offer, Appointment, Contract, SalarySlip) confirmed to have Send-to-Employee save paths; VacancyGenerator is admin-only text output (correct). (7) **Notification routing** — routing table now covers all 17 enum types; `TASK_ASSIGNED → RECIPIENT` was the only gap. ⚠️ **`db:push` required on Linode** (TASK_ASSIGNED added to NotificationType enum).
- **Reports windowed time-period pills (2026-05-27):** All three Reports pages (`/reports`, `/reports/[employeeId]`, `/reports/links`) now share one time-period pill set — **24h / 48h / 7d / 14d / 30d / 90d / Year** + custom From/To — defined once in [apps/internal/src/app/reports/_range.tsx](apps/internal/src/app/reports/_range.tsx) (`RangePills`, `presetStart`, `todayISO`, `rangeLabel`; the `_` prefix keeps Next.js from routing it). **"Everything follows the pill"**: every stat card, platform card, chart, breakdown and report list recomputes for the selected window. ⚠️ **The user-reported bug here was the employee-detail filter "not working whatsoever"** — root cause was `GET /admin/reports/employee-stats/:id` ignoring the date range (hardcoded all-time / last-30-days), so the stats strip + chart stayed frozen while only the bottom list moved. Fixed by making that endpoint range-aware (`startDate`/`endDate` query params drive `totalReports`, `totalLinks`, `avgLinksPerDay`, `submissionRate`, `dailyTrend`, `weeklyTrend`, `platformBreakdown`). **Streaks stay all-time** (a current streak is meaningless scoped to a window). `submissionRate` = reporting-days / window-days (capped 100%). `dailyTrend` zero-fill is **capped at 90 buckets** so a "Year" range doesn't return 365 chart points. The main page's old hardcoded-"Today" column + today-modal were removed (redundant once Total Links is windowed); the per-employee `platformBreakdown` from `getReportSummary` is already windowed and powers the breakdown modal. The shared pills use the main page's cream/ink palette (`bg-[#1A1A1A]` active) on all three pages, including the indigo-themed links/employee pages — intentional for cross-page consistency. **No `db:push` required** (query-param + frontend only). Verified end-to-end in a headless browser: pills present on all 3 pages, active pill highlights, switching windows changes the numbers (30d→1 report/2 links, 24h→0/0, Year→1/2 with SubRate 0%).
- **Reports filter reorder + employee-scoped cards (2026-05-27 follow-up):** On the main `/reports` page the Filters card now sits **above** the stat + platform cards (choose window/employee first, then read the numbers). When an employee is selected from the dropdown, the stat cards + platform cards scope to **that employee** (derived from their entry in `summary.employees`, which is already per-employee + windowed) instead of staying team-wide. The first stat card swaps from "Employees Reporting" → that employee's "Current Streak"; the Avg-card modal and platform cards use the employee's `platformBreakdown`. The employee-detail page already had its filter above the cards and was already single-employee-scoped — no change needed there; the links-analytics page is org-wide with no employee filter. Frontend-only, no `db:push`.
- **Reports bug batch (2026-05-27 follow-up 3):** Three fixes on the Reports pages. (1) **Employee filter showed team data** — when an employee with **0 reports in the selected window** was picked, the cards fell back to team-wide totals (the `selectedEmployee ? … : team` ternary went falsy because they weren't in `summary.employees`). Now keyed on `isEmployeeView = !!employeeId`: a selected-but-absent employee shows **zeros**, never team totals. `selectedEmployeeName` resolves the name from the `useEmployees` list so labels work even with no windowed data. (2) **X-axis labels hidden** — the employee-detail chart had a hardcoded `interval={4}`, so a 7-day chart showed only 2 labels (and a Year chart would crowd). Both employee + links charts now use `interval={Math.max(0, Math.ceil(len / 8) - 1)}` to target ~8 evenly-spaced labels at any window. (3) **Duplicate platforms (`Instagram` vs `instagram`, `LinkedIn`, etc.)** — `report_links.platform` has mixed casing (Title-case from `Platform.name`, lowercase from client-sent strings). The **employee-stats** endpoint was grouping by the raw string (line ~135), unlike the team-summary + links-analytics which already `.toLowerCase()`. Fixed to lowercase there too, collapsing the buckets. **Root cause is the data** (mixed casing in `report_links.platform`); the display fix normalizes everywhere it's read. A one-time prod backfill to lowercase `report_links.platform` would be the belt-and-suspenders fix but wasn't run (display layer fully covers what users see). Frontend + service only, no `db:push`.
- **Reports per-employee daily drill-down + restored Today column (2026-05-27 follow-up 2):** (1) `getReportSummary` now emits a `dailyBreakdown` inside **each employee's** `platformBreakdown[i]` (via a new `empPlatformDailyMap` per employee), so the platform-card daily drill-down modal works in **employee mode too** (previously team-mode only). (2) The **"Today" column** in the Employee Summary table — removed in the earlier windowed-pills refactor — is **restored**. It is deliberately **filter-independent**: `linksToday` / `todayPlatformBreakdown` are computed from *today* regardless of the selected window, and clicking the pill opens a platform-wise modal exactly like the Total Links pill. To keep it truly filter-independent, `getReportSummary` now **merges today's submitters into the employee list even when today falls outside the window** (their windowed `reportCount`/`totalLinks` stay 0 but their live `linksToday` shows); `employeesReporting` counts only `reportCount > 0` so today-only merges don't inflate it. ⚠️ Don't "simplify" by dropping the Today column again — it's a load-bearing convenience the user relies on. Frontend + service only, no `db:push`. Verified in-browser: Today pill → modal "3 links today · Instagram 2 (67%), Facebook 1 (33%)".
- **YouTube link insights shipped (2026-05-30, commits 528bb63, 2eb48ed, 14284b0, 6ef960d):** `link_metrics` table stores view/like/comment snapshots keyed on YouTube video ID. 6h cron in `apps/api/src/cron/social-insights.cron.ts` batches 50 videoIds per YouTube Data API call. Re-heal SQL query reconnects orphaned snapshots after delete-and-recreate resubmits (nullable linkId + SetNull on the FK). `YOUTUBE_API_KEY` added to prod `apps/api/.env` (runtime-only, no rebuild needed). Provider pattern: `apps/api/src/services/social-insights/` with youtube.provider.ts live; instagram/facebook stubs present. Route ordering fix: insight routes must be declared before `/:reportId` in admin-reports.routes.ts or Express captures them as report IDs. Metrics visible in Internal /reports (5th stat card + Top YouTube Links panel) and HR /report (insights panel below form).
- **HR report draft auto-save (shipped 2026-05-30):** Server-side draft stored in `report_drafts` table (keyed on employeeId + dateKey). Auto-saves debounced 3s after any change. Works before AND after submit — if employee adds more links after submitting and closes the tab, those additions are restored on next page load (draft timestamp vs submitted report timestamp determines which wins). Draft cleared on successful submit. `PUT/GET/DELETE /hr/reports/draft` endpoints on `authenticateHr` middleware.
- **Cross-day duplicate links now silently dropped (2026-05-30):** `submitDailyReport()` in `daily-report.service.ts` previously threw 400 DUPLICATE_LINKS when any submitted link existed in a previous day's report. Now silently filters them out before inserting, matching the frontend auto-dedupe behaviour. Frontend also re-arms cross-day dedupe after every Smart Paste. Fixes Kanishka-style "already submitted" hard block.
- **Added-links-vanish-on-resubmit fixed (2026-06-04, the "Anish" bug):** Heavy *incremental* submitters (e.g. 181 links saved, paste +22 more, resubmit) lost the additions — the POST returned 201 but only the original set persisted, and the count reverted on hard refresh. **Root cause was CLIENT-side, not the server.** In [apps/hr/src/app/report/page.tsx](apps/hr/src/app/report/page.tsx), `handleSubmit`'s resubmit branch did `draftRestoredRef.current = false; setPrefilled(false)` to "re-arm" the restore effect. But that effect is keyed on `[todayData]`, and the `await mutateToday()` just above it changes `todayData` → the restore effect **re-ran and `setLinks(existing.links)` clobbered the live form** (base + freshly-pasted) with the stale server snapshot *before* the additions were ever sent. Proven via prod forensics: the surviving links' `firstSeenAt` stopped exactly at the last pre-clobber moment; the server is correct (a single POST of the full set always persists the full set — see the "Anish scenario" + "removal still works" integration tests in `daily-report.test.ts`). **The fix (three client-side changes, server untouched):** (1) **removed the harmful re-arm** — auto-save still works because its guard only needs `draftRestoredRef.current === true`, which stays true; (2) **`formIsPristine()` guard** on all three restore/prefill `setLinks` calls so restore can never overwrite a form that already holds user content (defense-in-depth); (3) **payload snapshot** (`payloadLinks`/`payloadNotes`) captured before the geolocation `await` so a mid-submit paste/restore can't change what's POSTed; plus an `if (loading) return` **in-flight guard** in `handleSubmit` (the `disabled={loading}` button is cosmetic — Enter/rapid taps re-enter). **Deliberately NOT changed:** the server delete-and-recreate transaction stays as-is (it's correct and load-bearing; intentional link *removal* relies on it — a "merge/additive" server fix would break removal, metric edits, and scheduled-link cleanup). The server TOCTOU race (two overlapping POSTs → last-writer-wins) is a known *secondary* hazard now largely closed by the in-flight guard; left for a future dedicated change with load testing rather than bundling a risky Serializable-isolation rewrite into a hotfix. Frontend-only, no `db:push`.

### Employee vs Admin distinction (analytics/reports)

The `User` table holds everyone — employees, Team Leads, Admins, and Super Admins all share the same model. There is no `isEmployee` flag. The convention for "employee-facing" counts (Active Employees stat on dashboard, submission rates, non-submitters, attendance rates) is:

```ts
const employeeWhere = {
  status: "ACTIVE" as const,
  deletedAt: null,
  roles: { some: { role: { name: { notIn: ["Super Admin", "Admin"] } } } },
};
```

This is defined once at the top of `apps/api/src/services/analytics.service.ts` and reused across all three employee-count queries in that file, and in the `nonSubmitters` query in `apps/api/src/routes/admin-reports.routes.ts`.

**Why `some: { notIn }` not `none: { in }`:** A user with both `Admin` + `Employee` roles passes this filter because they have at least one non-admin role — they are treated as an employee. Only a pure-admin (sole role = Super Admin or Admin, no employee-level role) is excluded. This is the correct semantic.

### QA-confirmed (2026-05-23)

Full end-to-end QA completed 2026-05-23. All major systems pass. Key findings:

- **RBAC token isolation:** `auth.ts` middleware does NOT check `token.type` — it only verifies the JWT signature. `hr-auth.ts` DOES check `payload.type !== "hr"` → 403. The type check is per-middleware; RBAC resource permissions are the second gate for internal endpoints.
- **`offerDate` already present:** Both `OfferLetterGenerator` and `AppointmentGenerator` in [ai-assistant/page.tsx](apps/internal/src/app/ai-assistant/page.tsx) include `offerDate: new Date().toISOString().split("T")[0]` in their `sendToEmployee()` POST bodies.
- **Common endpoint path mistakes** (use the right column):

  | Wrong | Correct |
  |-------|---------|
  | `POST /admin/salary-slips` | `POST /admin/salary-slips/generate` |
  | `POST /admin/job-listings` | `POST /admin/jobs` |
  | `GET /notifications` | `GET /admin/notifications` |
  | `GET /hr/leave` | `GET /hr/leave-requests` |
  | Announcement body: `content` | Use `message` |
  | Task body: `assignedTo` | Use `assigneeId` |
  | Account assignment: `userId` | Use `employeeId` |
  | Contract `contractDate`: YYYY-MM-DD | Must be ISO-8601 DateTime: `2026-05-23T00:00:00.000Z` |

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

### Bootstrapping admin access (lockout recovery)

The system is "locked" by design — only an existing admin can invite new admins. If no admin can log in, you escape via the seed:

- **Hardcoded seed accounts** (in `packages/db/prisma/seed.ts`):
  - `admin@digitalsukoon.com` — password from `SEED_ADMIN_PASSWORD` env var (default `Admin@123456`)
  - `tabish@dashmani.com` — password `admin@123` (this is **reset on every seed run** because the `update` block sets `passwordHash` on existing rows)
- Both accounts get the `Super Admin` role on every seed run. The seed is fully idempotent (`upsert` for every entity).

**Re-run the seed on production** (use this any time you need to reset the admin password or restore lockout access):
```bash
ssh linode
cd /opt/dashmani-platform/packages/db
npx tsx prisma/seed.ts
# Do NOT use `npm run db:seed` on prod — Turbo 2.x's strict env policy blocks
# SEED_ADMIN_PASSWORD from passing through. The direct tsx invocation works
# because @prisma/client auto-loads packages/db/.env on initialization.
```

After the seed, `tabish@dashmani.com / admin@123` will work via `POST /v1/auth/login`. To change either hardcoded credential, edit `packages/db/prisma/seed.ts` and redeploy.

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

### Diagnosing a "Load failed" or other frontend-only outage

If users report the UI is broken but the API works, walk through this layer-by-layer to find which layer is actually stale. Don't skip layers — each one can mask the other.

**Layer 1 — API works at all?**
```bash
curl -s https://api.digitalsukoon.com/v1/health
# → {"success":true,"data":{...}}
```

**Layer 2 — API works for the failing flow?** Hit the actual endpoint with the same `Origin` header a browser would send:
```bash
curl -sI -X OPTIONS https://api.digitalsukoon.com/v1/auth/login \
  -H "Origin: https://portal.digitalsukoon.com" \
  -H "Access-Control-Request-Method: POST"
# Look for: access-control-allow-origin: https://portal.digitalsukoon.com
```
If CORS headers are missing, check `apps/api/src/index.ts` cors config and `EXTRA_CORS_ORIGINS` in prod `apps/api/.env`.

**Layer 3 — Server has the latest commit?**
```bash
ssh linode "cd /opt/dashmani-platform && git rev-parse --short HEAD"
# Compare to your latest pushed commit. If they differ, the deploy didn't reach the server.
```

**Layer 4 — `.env.local` on server is correct?**
```bash
ssh linode "for app in internal client hr jobs; do echo -n \"\$app: \"; cat /opt/dashmani-platform/apps/\$app/.env.local; done"
# All four should print: NEXT_PUBLIC_API_URL=https://api.digitalsukoon.com/v1
```

**Layer 5 — The build on disk has the correct URL baked in?**
```bash
ssh linode "grep -roE 'https://api\\.digitalsukoon\\.com[^\\\"]*' /opt/dashmani-platform/apps/internal/.next/static/chunks/app/login/ | head -3"
# Should return at least one match. (Note: leftover `localhost:4000` strings can
# show up in built JS as DEAD fallback literals from `... || \"http://localhost:4000\"`
# patterns — ignore those, look for the positive match of the prod URL.)
```

**Layer 6 — Cloudflare/CDN is serving the new chunks?**
```bash
curl -s "https://portal.digitalsukoon.com/login" | grep -oE '"/_next/static/chunks/app/login/[^"]+\.js"' | tr -d '"'
# Take the first result and fetch it:
curl -s "https://portal.digitalsukoon.com<chunk-path>" | grep -oE 'https://api\.digitalsukoon\.com[^"]*' | head -1
# If empty → Cloudflare is caching the old chunk. Purge Cloudflare cache for that path.
```

**Layer 7 — User's browser is using the new chunks?**
- If layers 1–6 all pass but the user still sees "Load failed", their browser has a stale cache or service worker.
- Tell them: hard refresh (`Cmd+Shift+R` / `Ctrl+Shift+R`) or open in incognito.
- For a definitive test, open DevTools → Network → reload → click the failing fetch → check the Request URL. If it shows `localhost:4000`, it's browser cache. If it shows `api.digitalsukoon.com` and still fails, look at the response (CORS, 5xx, etc.).

The point of this checklist: **never assume the layer above worked just because the layer below did.** Most "the deploy didn't work" reports turn out to be browser cache after layers 1–6 pass cleanly.

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
| Browser shows "Load failed" on login (no API request fires) | `NEXT_PUBLIC_API_URL` was baked as `localhost:4000` at build time | `deploy.sh` now overwrites `apps/*/.env.local` on every deploy — re-run a deploy. If the file got corrupted between deploys, `ssh linode && for app in client internal hr jobs; do echo "NEXT_PUBLIC_API_URL=https://api.digitalsukoon.com/v1" > /opt/dashmani-platform/apps/$app/.env.local; done && bash /opt/dashmani-platform/scripts/deploy.sh` |
| "Load failed" persists in browser even though `curl` to the API works and the served JS chunk contains the correct prod URL | Browser is serving cached JS from before the fix. Next.js sets `cache-control: public, max-age=31536000, immutable` on chunks; old chunks may also be in a service worker or Cloudflare edge cache | First confirm the fix is live: `curl -s "https://portal.digitalsukoon.com/_next/static/chunks/app/login/page-*.js" \| grep -oE 'https?://api\.digitalsukoon\.com[^\"]*'` should return the prod URL. If yes: **hard refresh the browser** (`Cmd+Shift+R` / `Ctrl+Shift+R`) or open in an **incognito window** to bypass cache. To force every visitor's cache to invalidate, purge Cloudflare cache from the dashboard. Chunk filenames include content hashes so a fresh build *should* be picked up automatically — only a stuck cache prevents that. |
| Seed fails on prod with `SEED_ADMIN_PASSWORD env var is required` via `npm run db:seed` | Turbo 2.x strict env policy doesn't pass `SEED_ADMIN_PASSWORD` through | Run seed directly, bypassing Turbo: `ssh linode && cd /opt/dashmani-platform/packages/db && npx tsx prisma/seed.ts` (Prisma auto-loads `packages/db/.env` which now contains `SEED_ADMIN_PASSWORD`) |
| GitHub Actions shows ❌ for a deploy but the next ✅ deploy serves old `internal` UI | `@dashmani/internal#build` OOM-killed mid-flight on Linode's 2GB RAM; Turbo cache for other apps lets the next deploy pass, but `internal` was never rebuilt — pm2 is still serving the old `.next/` | `ssh linode "cd /opt/dashmani-platform && rm -rf apps/internal/.next && NODE_OPTIONS='--max-old-space-size=900' npm run build -w @dashmani/internal && pm2 restart internal"` then run `npm run db:push` if schema changed |

---

## Local dev troubleshooting

### "Portal renders as unstyled HTML" or "Hero page lost its design"

**Symptom:** You open `http://localhost:3000/login` (or `:3001`, `:3002`) and see giant unstyled text, default browser fonts, no layout — basically raw HTML with `<h1>` and form fields stacked vertically. Tailwind classes are present in the DOM (visible in DevTools) but none of them apply.

**Root cause (95% of the time):** The Next.js dev server's `.next/` build cache went stale. The served HTML references a CSS chunk path like `/_next/static/css/app/layout.css?v=<timestamp>`, but that file doesn't exist on disk anymore — the dev server returns its 404 HTML page **with a `200 OK` status and `Content-Type: text/html`**, which the browser silently treats as an empty stylesheet. Result: HTML renders, no styles apply.

**How to confirm it's this:**
```bash
# Replace 3002 with the broken port. Pull the login HTML, extract the CSS URL, fetch it:
curl -s http://localhost:3002/login -o /tmp/p.html
cssurl=$(grep -oE '/_next/static/css/[^"?]+\.css' /tmp/p.html | head -1)
curl -s "http://localhost:3002${cssurl}" | head -c 200
# If the response starts with `<!DOCTYPE html>` instead of CSS rules, that's the bug.
# Healthy response starts with `/*` or `@charset` or a CSS selector.
```

Also check the response size: a real Tailwind dev CSS is ~50–150 KB. If `wc -c` on the response shows < 10 KB and it starts with `<!DOCTYPE`, it's the 404-HTML-as-CSS case.

**Fix:** Nuke the broken app's `.next/` cache and restart only that dev server. Don't touch the others.
```bash
# 1. Find and kill the dev server for the broken port (example: HR on 3002)
lsof -ti:3002 | xargs kill
# 2. Delete the cache
rm -rf apps/hr/.next
# 3. Restart just that one (background so terminal stays usable)
npm run dev -w @dashmani/hr &
# 4. Wait for it to compile, then verify
until curl -s -o /dev/null -w "%{http_code}" http://localhost:3002/login | grep -q "200\|307"; do sleep 1; done
curl -s "http://localhost:3002/_next/static/css/app/layout.css" | wc -c
# Should now print > 50000
```

**What NOT to do when you see this:**
- ❌ Don't "fix" the page's `layout.tsx` or convert `"use client"` to a server component. The layout is fine — the cache is broken.
- ❌ Don't rewrite the hero page assuming the design is wrong. The design is fine — the CSS isn't loading.
- ❌ Don't `git stash` your in-progress hero-page work to "rule out local changes." The bug has nothing to do with your code. (Stashing untracked hero work and then making layout edits is how this gets *worse* — see the 2026-05-19 incident.)
- ❌ Don't run `git checkout HEAD --` on layout files unless you've **first** verified via the curl test above that the CSS file is healthy. You'll discard real work.

**Why it happens:** Next.js 14 dev mode lazy-compiles routes and writes CSS chunks to `.next/static/css/`. If the dev process is killed mid-compile, hot-reloaded across a `layout.tsx` change that re-derives the CSS hash, or the file is partially written and then orphaned, the served HTML can end up pointing at a stale chunk filename. The dev server's 404 handler returns its HTML error page at *any* unknown `/_next/static/*` path, so the browser sees `<link rel="stylesheet" href="/_next/static/css/app/layout.css?v=foo">` resolve to HTML and silently drops it.

### Other common local-dev gotchas

| Symptom | Cause | Fix |
|---|---|---|
| `npm run dev` fails immediately with `EADDRINUSE :::4000` (or `:3000`, `:3001`, etc.) | Previous dev servers still running from an earlier session | `lsof -ti:4000,3000,3001,3002,3003 \| xargs kill -9` then `npm run dev` again |
| Internal portal stuck on loading spinner forever after a hard refresh | `apps/internal/src/app/layout.tsx` runs auth check in `useEffect` and renders a spinner during `isLoading`. If `localStorage.getItem("user")` throws or `JSON.parse` fails on a malformed value, `setIsLoading(false)` never runs | Open DevTools → Application → Local Storage → `localhost:3000` → delete the `user` key, then refresh. Long-term: wrap `JSON.parse(storedUser)` in try/catch |
| Client portal home (`/`) shows the sidebar shell but no content for a flash before redirecting | Pre-existing behavior — `layout.tsx` renders `<PortalShell>` before the `useEffect` redirect to `/login` fires. It's an SSR/CSR boundary artifact, not a bug. The redirect happens within ~50ms. | Not a real bug. Don't try to "fix" it by moving auth logic out of layout — last attempt broke all three portals. |
| Browser still shows the old broken UI after the fix is verified working via `curl` | Browser cache / hot-reload didn't kick in | Hard refresh: `Cmd+Shift+R` (macOS) / `Ctrl+Shift+R` (Windows). If that fails, open in an Incognito/Private window. |

### The diagnostic order for "portal looks broken"

Follow this in order. Don't skip steps. The most common bugs are at the top.

1. **Is the dev server even running?** `lsof -ti:<port>` should return a PID. If empty, `npm run dev -w @dashmani/<app>`.
2. **Is the CSS healthy?** Run the curl test from the "Portal renders as unstyled HTML" section above. If CSS returns HTML, nuke `.next/` and restart.
3. **Is the API running?** `curl http://localhost:4000/v1/health`. If not, `npm run dev -w @dashmani/api`. Submitting login forms will fail silently with "Load failed" if the API is down.
4. **Is the browser caching?** Hard refresh or open Incognito.
5. **Only after 1–4 pass:** look at the actual page code. 90% of "broken UI" reports are layers 1–4, not layer 5.

**The lesson from the 2026-05-19 incident:** Touching `layout.tsx`, stashing work, and "fixing" the page code in response to an unstyled-HTML symptom — without first running the curl test from step 2 — destroyed hours of hero-page work that had to be recovered from `git stash`. The actual bug was a stale `.next/` cache; the hero pages were never broken. **Always verify the CSS first.**
