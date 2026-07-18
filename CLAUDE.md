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
- **Link engagement metrics — YouTube shipped 2026-05-30; Instagram + Facebook LIVE 2026-06-23 via Meta Graph API (permanent System User token).** `link_metrics` table + 6h cron polls links in `report_links`. Views/likes/comments visible in Internal /reports + HR /report. Provider pattern in `apps/api/src/services/social-insights/` — youtube/instagram/facebook all live. `SUPPORTED_INSIGHT_PLATFORMS` in packages/shared = `["youtube","instagram","facebook"]` (the single switch). **Meta auth:** a permanent `SYSTEM_USER` token (never expires) is in prod `apps/api/.env` as `META_SYSTEM_USER_TOKEN` (+ `META_APP_ID=998903906094758` Dashmani Insights, `META_APP_SECRET`). Token reaches 87 Pages / 38 IG accounts (read scopes: instagram_basic, instagram_manage_insights, pages_read_engagement, **pages_read_user_content** (enabled 2026-06-24 for FB comments), pages_show_list, read_insights). **The Meta App does NOT need to be published** — System-User reads of your own business's accounts work on Standard access in Development mode (App Review/publishing is only for reading OTHER businesses' data). NOT a scraper (see crawler-rejection rule below).
  - **IG provider** pages each managed IG account's `/media` (shortcode→media map), reads caption+like_count+comments_count. **FB provider rewritten to the OWNED-PAGE model (PR #37, 2026-06-24):** per administered Page (those with `tasks` in `/me/accounts`) mint a Page token (`GET /{page-id}?fields=access_token`) → page `/{page-id}/published_posts?fields=id,permalink_url,message` (caption) → per matched post `GET /{post-id}/insights` for engagement: `post_video_views`→views, `post_reactions_by_type_total`(summed)→likes, `post_activity_by_action_type`→{comment,share}. **Why this path, NOT `GET /{post-id}` with `likes.summary`:** those summary FIELDS + the `/feed` edge require FULL App Review (return `(#10)` in dev/"Ready for testing"), but `/published_posts`+`message` and `/{post-id}/insights` (governed by read_insights) ARE honored in testing — proven live. **⚠️ DUAL-ID (the killer gotcha, only caught by live verify):** a FB reel has TWO ids — the `/reel/<n>` PERMALINK id (what canonicalKey/submitted-links resolve to → map KEY) and the `{pageId}_{postId}` COMPOSITE id (the ONLY id `/insights` accepts; permalink id returns empty, bare tail → `(#12) deprecated`). The provider keys the map on the permalink id but calls `/insights` with the composite. Split metrics into 2 `/insights` batches (views vs reactions+activity) — one post type's invalid metric 400s the whole call. Both IG+FB providers expose `harvestContent()` so the cron persists EVERY captioned post paged this run (firehose-proof), keyed canonicalKey, independently guarded (never affects metrics). Env knobs: `IG_BACKFILL_*` / `FB_BACKFILL_MAX_PAGES`(default 8) / `FB_BACKFILL_WINDOW_DAYS`(default 90).
  - **Display-contradiction fixes + follower-growth analytics + Snapchat verdict (2026-06-25 — PRs #38/#39/#40, no `db:push` in any):** An end-to-end audit found the *pipelines* sound but several *display* contradictions, all from FB insights being LIVE (PR #37) while the UI still said "pending Meta approval". **PR #38** (frontend+comments): unified the two divergent `InsightBadge` components (the internal one wrongly always-rendered an Eye/views icon → a fake "—" for IG/FB and dropped comments; now matches HR's views-if-present + likes + comments — note the internal `InsightBadge` is actually *orphaned*; the live internal metric rendering is INLINE in `reports/page.tsx`); removed every stale "Facebook pending Meta approval" string (internal Top-Links panel, HR report subtitle, Link Search coverage banner, 4 backend comments — only the accurate "no full App Review" note in `facebook.provider.ts` remains); showed the **Facebook Views column** (FB fetches `post_video_views`; was YouTube-only) via a per-platform `showViews` flag (IG stays no-views — genuinely null); made `reports/page.tsx`'s local `fmtCompact` null-safe (it would have rendered the literal string "null" in the new FB Views column). **PR #39** (Meta Graph follower swap + growth UI): new `apps/api/src/services/social-insights/meta-followers.ts` fetches IG/FB follower counts via the Graph API (same `META_SYSTEM_USER_TOKEN`); `follower-sync.service.ts` is now Graph-first with the existing scrapers as a **fail-open fallback** (empty map ⇒ exact prior behavior, never throws); fixed a latent **IST date-key bug** in the snapshot write (`new Date();setHours(0,0,0,0)` UTC → `istMidnight(todayIST())`); added `getGrowthOverview()` + `GET /admin/growth[/:accountId]` and an internal **`/accounts/growth`** overview page + per-account follower-trend chart. **⚠️ IG follower fetch is a TWO-STEP** (`me/accounts?fields=instagram_business_account` → ids, then per-id `GET /{ig-id}?fields=username,followers_count,...`): the nested-field expansion `instagram_business_account{username,followers_count}` is **NOT honored by the live Graph API — it returns only `{id}`**. Caught ONLY by a live probe (mocks "passed" the fictional nested shape); **always live-probe a new Graph fetcher against the real token before trusting it.** **PR #40** (docs): `docs/SNAPCHAT-CONNECTION-STEPS.md` — Snapchat **cannot** be auto-connected (no public follower-count API, no organic Story/Spotlight read API — Snap's dev surface is ads-only; no caption read path so Link Search is impossible too). Manual entry only, same bucket as TikTok/LinkedIn/Twitter; doc carries a drop-in playbook if Snap ever ships a read API. ⚠️ **The "no organic Spotlight read API" half of this is superseded 2026-07-15 (PR #97)** — the doc's own conclusion was about official APIs; a token-free public-page scraper for the `/spotlight/<id>` shape (a different page than what was investigated here) shipped instead. Follower-count-only framing still holds for Stories. See the PR #97 entry further down.
  - **⚠️ KNOWN HARD LIMIT — IG *and* FB historical coverage is ~1%, by Meta API design (not a bug, SAME ceiling for both).** Neither IG nor FB has fetch-by-id; the only read path is paging an owned account/Page's feed newest-first (IG `/media`, FB `/published_posts`). High-volume "firehose" accounts bury old posts beyond reach — **measured ~1% historical resolve** for IG (canary 2026-06-23) AND FB (backfill 2026-06-24: 1 of 3,378 clean links matched, even at deep window=1825/maxpages=100). **Forward coverage is HIGH** for both (fresh posts are top-of-feed; the 6h cron's `harvestContent` captures them). So: YouTube fully covered; IG/FB accurate for posts on/after go-live, partial before. The search UI's coverage banner states this honestly per-platform ("X searchable of Y submitted · since <auto-detected date>"). **Don't grind deep historical backfills for IG OR FB** — we tried both, same diminishing-returns wall (Meta truncates the firehose feed); deeper paging just burns the shared ~200-call/hr rate budget. **The "App Review gate" was a red herring** — FB captions+views+likes+comments work TODAY via the owned-Page `/published_posts`+`/insights` path on administered Pages (see provider note above); full App Review is only needed for the `likes.summary`/`comments.summary` post FIELDS we deliberately don't use. Historical work is DONE; forward is automatic. Original handoff: `docs/superpowers/plans/2026-06-23-ig-fb-futureproof-handoff.md`.
  - **Link Search enrichment reliability fix (2026-06-25 — branch `fix/link-search-enrichment-reliability`, no `db:push`).** A "Link Search shows only 1 Ananya Panday post / IG data incomplete since 24–25 Jun" report. Root cause via live audit: IG/FB caption enrichment was *under-running*, not failing cleanly — only the slice of posts top-of-feed during the one cron window that completed got harvested (1,079 of 40,801 IG posts ≈ 2.6%). Recent cron runs logged **only YouTube** — no IG/FB summary, no `[social-insights] done` — meaning a slow/throwing provider could prevent the run from completing, and the run rotated out of the pm2 buffer / was abandoned on restart. Fixes: **(1) IG discovery must use the BARE `instagram_business_account` field, NOT `instagram_business_account{id}`** — the nested sub-selection intermittently HTTP-500s and `discoverIgUserIds()` then silently returned `[]` (zero accounts → zero harvest); the bare field is honored (verified live; mirrors `meta-followers.ts`). A zero-discovery now logs a loud warn. **(2) The cron wraps each provider in try/catch so one provider's failure can't starve another; every provider always logs a summary; `[social-insights] done in Xms` ALWAYS prints; the harvest line logs even at 0.** **(3) FB-URLs-under-the-IG-provider** (dirty `report_links.platform`) no longer spam per-URL `could not extract targetId` warnings — replaced by an aggregate skip count. **(4) `INSIGHTS_DEBUG` env** enables per-account paging-depth logging (answers "why wasn't post X harvested?" without a code change). **(5) Manual trigger:** `POST /admin/insights/refresh` (fire-and-forget, no double-run, never blocks the request) + `GET /admin/insights/status` (live `{running, phase, startedAt, finishedAt, lastError, durationMs}`), both `requirePermission("reports","view")`; backed by an in-memory `apps/api/src/services/insights-runner.ts` singleton. **(6) Link Search page** got a **Refresh enrichment** button (polls status every 4s, shows phase, re-validates the coverage SWR on completion), a plain-language explainer of what enrichment does + that it takes a few minutes, and a calm API-issue/rate-limit message (never a raw error). The **firehose historical ceiling (RC-3 above) is accepted as Meta physics** — forward coverage is now reliable + observable; the coverage banner stays honest about the historical tail. Audit: `.planning/LINK-SEARCH-ACCURACY-AUDIT-2026-06-25.md`; plan: `.planning/LINK-SEARCH-FIX-PLAN-2026-06-25.md`. ⚠️ **Never re-introduce the `instagram_business_account{id}` nested form** in any Graph fetcher — always live-probe a new Graph fetcher against the real token. **Two follow-up fixes the same day, found ONLY by prod verification (always verify a Graph/cron fix LIVE, not just by build/tests):** (a) **harvest moved EARLY** (`social-insights.cron.ts`) — it now runs right after the first batch builds the feed map (~2 min in), not after the multi-hour 37k-link metric sweep that used to starve it. A `harvestedThisRun` flag (set only when the map had content, so a transient empty build retries) + a `!harvestedThisRun`-gated post-loop fallback ensure harvest runs once, early, never zero on a successful run. (b) **forward paging made SHALLOW by default** — `buildShortcodeMap`/`buildPostMap` page every managed account's feed ONCE before harvest can run; with the old 90-day window, firehose accounts (10k+ posts/yr) paged 20-25 pages each → the build took **~20 min** on the 2GB box and burned Meta's ~200-call/hr budget (shared with hourly follower-sync), perpetually starving the harvest. Lowered the FORWARD-cron defaults to **IG 8 pages / 21 days, FB 6 pages / 21 days** (in `instagram.provider.ts`/`facebook.provider.ts`; the `IG_BACKFILL_MAX_PAGES`/`IG_BACKFILL_WINDOW_DAYS`/`FB_BACKFILL_*` env vars still override for a one-off DEEP backfill, then unset). Forward posts are always page 1-2, so shallow paging captures today/yesterday reliably; deep history was never reachable anyway. **Live-proven 2026-06-25:** harvest persisted **15,862 IG captions in ~2 min** → IG `link_content` **1,079 → 16,170** (~40% of submitted, up from 2.6%). Newly-harvested captions then need entity extraction (Haiku, ~1.5s/row, cron cap 500/6h) before they're searchable by name; clear a large backlog with `cd packages/db && env ANTHROPIC_API_KEY=$(grep ^ANTHROPIC_API_KEY ../../apps/api/.env|cut -d= -f2-) npx tsx ../../scripts/extract-entities.ts --apply --confirm-prod` (the script loads `packages/db/.env`, which lacks the key). ⚠️ **Do NOT raise the forward paging defaults back to 60/90** — it re-starves the harvest. **(c) Extraction-lag surfaced in the UI (commit `b7e9a22`):** a caption is in `link_content` (`status='ok'`) once harvested but is NOT searchable *by name* until entity-extraction sets `extractedAt`. `buildCoverage()` now also returns `pendingExtraction` (`status='ok' AND extractedAt IS NULL`) and `nameSearchable` (`= searchable − pendingExtraction`, clamped ≥0), top-level + per-platform (additive, non-breaking; the index `@@index([extractedAt])` keeps the groupBy cheap). The Link Search coverage banner shows an honest note **only when pending>0** — *"N captured captions are still being tagged with people & topics — they'll be searchable by name within a few hours. (Use Refresh to check progress.)"* — plus a per-platform `· N tagging` suffix. The headline still leads with `searchable` (will-be-findable once tagged); `nameSearchable` is exposed for a future headline swap if wanted.
  - **Follower accuracy — public-API resolvers + stale/accuracy labels + fast manual refresh + opaque-link backfill (2026-06-25 — merge `e2b1b6e` on `main`, no `db:push`).** Report: Account Growth showed Bollywood Society (IG) at **4.2m** but the live profile is **4.6m**. **Root cause (verified live, NOT a sync bug): coverage, not correctness.** The follower-sync engine is accurate WHERE the Meta token reaches — of 144 IG rows, 33 matched a live Graph account and **0/33 were materially off**. But the token only administers **87 Pages → 38 IG accounts**; the other **109 IG / 177 FB rows are never-synced** (`last_synced_at IS NULL`) and show stale legacy/manual values that nothing updated. `bollywoodsocietyy` is one of these — not in our Business Manager, so never fetched. **The recovery path the user was confident existed, proven live: IG `business_discovery`** — any ONE of our connected IG nodes can read ANY public business/creator account's follower count by username, no admin access, ToS-compliant (`GET /{ourIgId}?fields=business_discovery.username({handle}){followers_count,media_count}`). Probed 8 stale handles → **7 resolved exact-live** (bollywoodsocietyy 4,209,514→**4,621,284**, matching the screenshot; the 8th was a renamed/private handle → HTTP 400 code 110, the clean skip case). **Shipped (8 tasks, Sonnet-impl/Opus-review):** (1) `fetchPublicInstagramFollowerMap(handles)` in `meta-followers.ts` (business_discovery; fail-open; rate-limit early-return). (2) `youtube-followers.ts` `fetchYouTubeSubscriberCounts()` — resolution cascade: known `UC…` id (handle or `/channel/` in profile_url) → `channels.list?id=` batched 50/call (1 unit); else `forHandle` (often empty — verified); else `search.list` (100 units, capped `maxSearchLookups`). ⚠️ YT `forHandle` is UNRELIABLE even for real channels; resolve by channel ID. (3) `fetchFacebookFollowerMap()` now ALSO keys by page **name** (lowercased) + `fbLookupKeys(handle,profileUrl)` (numeric id from `profile.php?id=`, `facebook.com/<seg>` skipping reserved segs, raw handle) — matches stale FB rows stored under display names to administered Pages. **FB has NO public non-administered read path** — `(#10) pages_read_engagement` on any page we don't administer (verified); FB recovery is ONLY administered-Page matching. (4) Wired as a fail-open **Tier-3** in `syncAllFollowerCounts()` (after the existing map+scraper tiers) via a shared `persistFollowerCount()` (single write path, `>0` guard, `istMidnight(todayIST())` snapshot). ⚠️ **Tier-3 IG is guarded by `igFollowerMap.size > 0` + a 30-handle cap (`IG_TIER3_MAX_HANDLES`)** — an empty Tier-1 map signals Meta is rate-limiting, and firing one `business_discovery` call per unresolved handle (~109) in one hourly run would starve the shared ~200-call/hr budget the harvest cron depends on; only attempted-and-missed handles count as `failed` (deliberate skips + the deferred tail beyond the cap are NOT failures). Also `igRateLimited` is reset at the top of `syncSingleAccountFollowers` (the per-account refresh button must always attempt the network, not inherit a batch run's rate-limit flag). (5) `getGrowthOverview()` returns per-account `syncState: LIVE|STALE|MANUAL` (`MANUAL`=`last_synced_at` null; `LIVE`=synced ≤48h; `STALE`=older — a raw `Date` duration diff, NOT the IST date-key, which is correct for a freshness window) + `lastSyncedAt`, plus top-level `liveCount/staleCount/manualCount` + `liveFollowers/staleFollowers/manualFollowers` (additive; total kept). (6) `/accounts/growth` UI: per-account `SyncBadge` (green Live·Xago / amber Stale·Xago / grey Manual) + a freshness note under the kept total ("X of Y live-synced · Z stale · W manual"); all defensively guarded so an old API response renders unchanged. (7) **Manual `POST /admin/insights/refresh` now runs HARVEST + EXTRACT ONLY** — `runSocialInsightsRefresh({ harvestOnly: true })` builds the feed map via the first batch, flushes the early harvest, then `break`s out of the per-link metric sweep (the harvest is the only thing Link Search needs). Fixes the "Refresh spins for HOURS" report: the old manual path `await`ed the full multi-hour 37k-link metric sweep before the runner flipped to idle; harvest finished in ~2 min but the spinner stayed up. The scheduled 6h cron still does the FULL run (metric sweep) — `index.ts` calls `runSocialInsightsRefresh()` with no args. ⚠️ the `if (harvestOnly && harvestedThisRun) break` fires only AFTER the harvest succeeds with content (transient empty map → no break, retry next batch) — never skips the harvest. (8) `scripts/resolve-opaque-fb-links.ts` — one-off backfill canonicalizing historical `facebook.com/share/` URLs → clean `/reel/<id>`. **⚠️ Overturns the old "opaque /share/ → pfbid, ~84% unrecoverable" assumption:** a live probe of 12 opaque `/share/r/` links resolved **12/12 to clean `/reel/<numericId>`** via a single unauthenticated 302 (the submit-time resolver `resolveFacebookShareUrl` in `facebook.provider.ts` + `resolveOpaqueShareLinks` in `daily-report.service.ts` already canonicalize NEW links at submit-time, outside the txn, fail-open — this script handles the existing tail). Dry-run default; `--apply --confirm-prod`; polite concurrency 3 / 200ms delay; non-destructive (only updates `url`, never deletes/nulls); idempotent (re-selects the shrinking `/share/` set). 80 new tests; full build green; **no `db:push`**. Plan: `.planning/FOLLOWER-ACCURACY-FIX-PLAN-2026-06-25.md`. ⚠️ **Never re-introduce `instagram_business_account{id}` nested form; always live-probe a new Graph/YT fetcher against the real token (mocks can't catch field-shape lies); never raise the IG Tier-3 handle cap without re-checking the shared Meta budget.** **Follow-up bug found ONLY by live prod verification (fix `ea8146e`, the deploy after the merge):** `fetchPublicInstagramFollowerMap` returned an EMPTY map on prod — its "find one administered IG node" discovery paged `me/accounts?fields=instagram_business_account&limit=100`, which on the prod token's **87 Pages takes ~25-30s and HTTP 500s** (Meta chokes resolving 100 Pages' IG node in one page) → hit the 10s `REQUEST_TIMEOUT_MS` → `ourIgId` null → empty. Fix: `const IG_DISCOVERY_PAGE_LIMIT = 5` for that discovery loop ONLY (we only need the FIRST IG id; the loop breaks at it). `limit=5` returns 200 in ~2.6s. **Verified live after fix: 5/5 handles resolved, bollywoodsocietyy → 4,621,323 in 4.4s.** ⚠️ Do NOT raise `IG_DISCOVERY_PAGE_LIMIT`, and do NOT apply it to `fetchInstagramFollowerMap` (which must page ALL administered IG accounts at `PAGE_SIZE=100` — it tolerates the slow page, ~25s, and needs every account). The lesson: tests + full build + a holistic review were ALL green, yet the deployed resolver was 100% broken on prod — the `limit=100`→500 behavior is specific to this token's Page count and invisible to mocked fetch. **Opaque-link backfill live result: 94% of sampled `/share/` links resolve to clean `/reel/<id>` (NOT the docs' old "84% unrecoverable" — that was inverted); ran `scripts/resolve-opaque-fb-links.ts --apply --confirm-prod` over 16,899 rows.**

  - **FB public-reel ENGAGEMENT scraper — Top Links now covers external reels (2026-06-25 — PR #41, merge `cf9486a`, no `db:push`).** Follow-up to the user's "facebook links still not in Top Links" + "use a scraper if not via API, and go deeper before concluding." **Overturns my own earlier "FB metrics only on administered Pages" conclusion** — that was true for the *Graph API* but NOT for a scraper. **Verified live from the Linode datacenter IP:** a logged-out GET of `https://www.facebook.com/reel/<id>` with a **Googlebot UA** (same trick as the follower scraper, commit `b40b142`) returns the full reel HTML, NO login wall, **40/40 first-try, zero blocks**. Engagement is embedded as JSON. **⚠️ THE FIELD GOTCHA (only caught by going deeper — one lucky sample lied):** the public view count is **`video_view_count`** (single occurrence, STABLE across fetches) — cross-checked vs Graph `post_video_views` on administered reels: **5/5 EXACT** (2=2,1=1,4=4). **`play_count` is CAROUSEL NOISE** — the reel page is a *feed* carrying ~22 recommended reels' `play_count`s; the first-match is unstable (2309/43198/2428 for the SAME reel across 3 fetches). The `og:title` "43K views · 264 reactions" string is served INCONSISTENTLY (present once, absent 0/12 later) → don't rely on it. likes=`reaction_count.count`, comments=`total_comment_count`. **Shipped:** `apps/api/src/services/social-insights/facebook-scraper.ts` (pure `parseFbReelHtml` + fail-open `scrapeFacebookReelEngagement`); `facebook.provider.ts` calls it as a `tryScrapeFallback` on the **not_found** branch ONLY — Graph still wins for administered reels (exact + free); the scraper fills the ~85-95% external majority. Kill switch `FB_SCRAPER_ENABLED=0`, polite `FB_SCRAPER_DELAY_MS` (default 250ms), per-run block short-circuit, numeric-id-only (opaque/pfbid skipped). 15 new tests (10 scraper unit incl. a `play_count`-rejection assertion + 5 provider fallback); 56→71 green. **Verified live on prod** (deployed `cf9486a`): the deployed provider resolved 6/6 real submitted reels → ok with scraped views/likes/comments (0 not_found; before this, all 6 were not_found). FB Top Links read path is safe — `getInsightsSummary` filters `status:"ok"` + latest-per-link, so the 6,636 stale FB `not_found` rows never suppress new `ok` rows. **FB administered overlap is ~5-15%** (deep-probed: 1,010/19,569 submitted reels at shallow paging, more with depth — NEITHER "0%" (my earlier error) NOR "all ours" (the user's belief); reconciliation: Graph covers the slice, scraper covers everything). **FB empty-state copy corrected**: old "only available for Pages we manage" was made FALSE by the scraper → now "collected in the background, refresh periodically" (the UI must speak the truth). **IG + Snapchat scrapers are a documented follow-up** (`.planning/SCRAPER-ENGAGEMENT-FOLLOWUP-2026-06-25.md`): IG og:description gives EXACT likes+comments+caption+handle (5/5 residential) but from the datacenter IP serves a **soft login-wall ~70% first-try, retryable to 8/8** — higher ban risk at 40k scale, needs careful per-run cap + ≥500ms delay + block short-circuit + LIVE small-scale verification first (NO views in IG og). Snapchat `/t/` exposes likes+caption via og:title (overturns the doc's "Snapchat = manual only, no caption path") — only 72 links, low ROI (⚠️ this og:title path was NOT what eventually shipped — PR #97, 2026-07-15, used the `/spotlight/<id>` page's `__NEXT_DATA__` blob instead, a more complete and stable source giving views+comments+shares, not just likes+caption). X/LinkedIn/TikTok: **zero links exist**, not worth building. ⚠️ **Always live-verify a scraper FROM THE LINODE IP** (residential success ≠ datacenter — IG was 5/5 residential but ~30% datacenter first-try); **never grab `play_count` for FB views** (carousel noise; tests lock this in); fail-open is non-negotiable (a scrape miss must keep the prior value, never block the cron). Also corrects the 2026-06-23 "free crawler NOT used" rule below: that was about *captions behind login walls* + 27k-request IP bans — but logged-out **Googlebot-UA engagement** reads work for FB (first-try) and IG (with retry), so a *bounded, polite, fail-open* engagement scraper IS viable where the Graph can't reach.

  - **Snapchat — non-working Link Search/insights REMOVED, then follower scraper FIXED, then confirmed followers-ONLY (2026-06-30 → 2026-07-01 — PRs #70/#73 + docs, no `db:push`).** ⚠️ **SUPERSEDED 2026-07-15 (PR #97) — see the entry below this one.** The "no server-readable engagement/caption, Snapchat = follower counts + growth chart only" conclusion below was correct for the URL shape probed at the time (`/p/<uuid>` **profile/Story** pages) but incomplete: a later, deeper probe of the **`/spotlight/<id>`** URL shape (a DIFFERENT page than the one investigated here) found real, stable, server-rendered engagement data. Keeping this entry for the accurate historical context (why the removal was the right call given what was known then, and why Story pages specifically remain a permanent dead end) — do not treat its blanket "don't re-attempt" as still authoritative; the corrected, current state is in the next entry. A multi-step correction of the Snapchat parity work (PR #69). **(1) PR #70 (`2fc5219`) removed** the submission-count "Top Snapchat Links", the Spotlight insight provider, and all Snapchat Link-Search wiring (`canonicalKey` `sc:` branch, `platformFromCanonicalKey`, `idPartFor`, coverage CTE, `SUPPORTED_INSIGHT_PLATFORMS`, banner ORDER). **Why:** a live Linode probe proved prod's 124 Snapchat links are all `snapchat.com/t/<code>` share redirects → client-rendered `/p/<uuid>` **profile** pages with NO server-readable caption/engagement, and there's no ungated public API. So caption-search is impossible for our (third-party, non-opted-in) accounts. **(2) PR #73 (`8b9a198`) fixed the follower scraper** — it was reading the WRONG url (`snapchat.com/add/<handle>`, which **404s** for all 7 accounts) instead of the account's `profile_url` (the `/t/` link → `/p/<uuid>` page where the count lives). AND the parser silently returned `null` on the real `/p/<uuid>` HTML (found by running the REAL parser on REAL fetched bytes): the JSON-LD `interactionType` is an **object** `{"@type":"FollowAction"}` nested under `mainEntity` (parser matched only a top-level string-URL), and `subscriberCount` is **quoted** `"98100"` (regex needed bare digits). Fix: `snapchatCandidateUrls(handle, profileUrl)` tries an http `profile_url` FIRST (`redirect:"follow"` resolves `/t/`→`/p/`), then legacy `/add/` fallbacks; parser handles object-form + nested `mainEntity.interactionStatistic` + quoted value; **added per-account logging** (the previously fail-SILENT scraper is why this went undiagnosed). Fail-open preserved (a miss keeps the manual value, never writes 0). **Live-proven on prod:** 4/7 resolve (bollywoodchronicle 44k→**98,100**, bollywoodsociety 99k→**147,300**, Moviefied Bollywood 0→**130,300**, intlfashion 73,400) with `account_growth_snapshots` written; the other 3 (movified/publicpov/totalfilmi) have **dead `t.snapchat.com` links** (⚠️ `t.snapchat.com/<code>` ≠ `snapchat.com/t/<code>` — the former is a dead short-link host, 404) + zero report_links → no recoverable source → fail-open + log; they need a corrected `profile_url` entered by hand (data fix). Growth **delta %** stays 0 until the 2nd daily snapshot — expected. **(3) ⚠️⚠️ FOLLOWER COUNT IS THE ONLY SCRAPEABLE SNAPCHAT METRIC FOR /p/<uuid> STORY PAGES — views/likes are NOT, by Snapchat's design, and this remains true (Story pages are still a permanent dead end after PR #97 below).** Live-verified from the Linode IP on a POST page (`/p/<uuid>/<storyId>?chapterid=…`): per-post engagement is served as **SENTINELS** — `"viewCount":"-1"`, `"shareCount":"0"`, plus a literal `"{viewCount}"` UI template — with **NO `WatchAction`/`ViewAction`/`LikeAction`**; the only real `InteractionCounter` is the profile-level `FollowAction` (followers). **NEVER add a views/likes parser for a `/p/<uuid>/<storyId>` Story page, or key any metric on `viewCount`/`shareCount` from that page shape** — same trap as FB `play_count`. (The allowlisted Snap Public Profile API paragraph that used to sit here — describing per-post views/shares as reachable only via that gated, low-ROI path — is also superseded: PR #97 found a token-free scraper path for the DIFFERENT `/spotlight/<id>` page shape instead. See the entry below.) Full feasibility + steps: `docs/SNAPCHAT-CONNECTION-STEPS.md` (⚠️ **also now stale for Spotlight** — updated for followers-only + Public-Profile-API framing, predates the PR #97 scraper finding). Memories: `project_snapchat_link_search_removed`, `project_snapchat_follower_scraper_fix`. **(4) PR #75 (`7e6b61a`) fixed the Account-Growth REDIRECT ("Sorry page")** — the Top Movers link icon + Accounts-list link built `snapchat.com/add/<handle>` (PR #72's "guarantee from handle" logic), which **404s** for all our accounts (→ `/@handle` Sorry page; same non-/add/-profile root cause). Both builders — `getGrowthOverview()` in `account-growth.service.ts` (~line 301) + `safeProfileHref()` in `accounts/page.tsx` — now PREFER the stored `profile_url` (the resolving `/t/`→`/p/` link), falling back to `/add/<handle>` only when there's no profile_url. The 4 dead-`t.snapchat.com` accounts still 404 (data fix — a valid profile_url must be entered by hand). ⚠️ **The "0 (0%)" in Top Movers is the growth DELTA, not the link** — delta = `latest − first` across `account_growth_snapshots`; with only 1 snapshot so far it's 0, populates on the 2nd daily cron. **Follower COUNT, growth DELTA, and link HREF are 3 separate things** — a 0% or a bad link is not a count bug.

  - **Snapchat Spotlight engagement insights + leaderboard/reports perf fix SHIPPED (2026-07-15 — PR #97, prod `b08ed77`, no `db:push`).** Overturns the "Snapchat = follower counts only" conclusion two entries above — that was correct for the `/p/<uuid>/<storyId>` **Story** page shape, but a later probe of the **`/spotlight/<id>`** page (a genuinely different page Snapchat serves) found real, stable, server-rendered engagement data with no login, no token, no allowlist. **The pipeline:** a submitted `snapchat.com/t/<code>` share link is redirect-resolved (submit-time, mirrors the FB `/share/` resolver) into a clean `snapchat.com/spotlight/<id>` URL **only when the redirect lands on a Spotlight** — if it lands on `/p/<uuid>/<storyId>` instead (a Story), resolution correctly gives up (Stories remain the permanent dead end described above). `snapchat-scraper.ts` (Googlebot UA, no login) fetches the resolved `/spotlight/<id>` page and parses the embedded `__NEXT_DATA__` JSON: `props.pageProps.spotlightFeed.spotlightStories[0].metadata.engagementStats` = `{viewCount, shareCount, commentCount}` (**index 0 ONLY** — indices 1-24 are unrelated recommended-feed neighbors, same first-match trap as FB `play_count`; never scan past index 0). Snapchat exposes **no public like metric for Spotlight** — `likes` is always `null`, never fabricated. `snapchat.provider.ts` plugs into the existing 6h cron registry (registered LAST — small/polite scraper, protects the bigger YouTube/Facebook/Instagram providers' time budget). `"snapchat"` added to `SUPPORTED_INSIGHT_PLATFORMS`. **One-time backfill** (`scripts/resolve-snapchat-links.ts`, dry-run default) run on prod: of 124 historical `/t/` links, **84 resolved to Spotlight, 40 confirmed Story** (independently verified via direct `psql`: 84+40=124, no data loss) — notably better than the pre-implementation sample-probe estimate (37.5% predicted vs 67.7% actual). UI: Top Snapchat Spotlights panel, Link Search coverage+caption-search+honest Story note, a per-platform leaderboard board ranked by views, dashboard Top Links pill, content-analytics color, HR `/report` subtitle. **⚠️ Two "fabricated `0` for null likes" bugs hunted down (same trap, `fmtCompact(n) => n ?? 0` treating a genuinely-absent metric as a real zero):** the leaderboard page's version had the bug (fixed by adding a `showLikes` flag mirroring the existing `showViews` pattern — hides the column entirely rather than showing a false "0"); the dashboard Top Links tile's version was already safe (gated on `metric==="views"`, and its own `fmtCompact` in `use-growth.tsx` already renders `"—"` for null) — verified this was a genuinely different, already-correct implementation, not a recurrence. **Any future platform with a null metric needs the same audit at every formatter call site it reaches, not just one.** ⚠️ **90-DAY-DEFAULT DEVIATION (Part B, the leaderboard perf fix, independent effort in the same PR):** the plan's literal spec had `getEngagementByEmployee`/`getEngagementByEmployeePlatform` (rewritten from unbounded `findMany`+JS-dedup to SQL `DISTINCT ON`, backed by a new `LinkMetric` index) default to a 90-day window when no dates passed. Implementation found `apps/hr/src/app/leaderboard/page.tsx` calls `useSWR("/hr/leaderboard", ...)` with **no date params, ever** — a real live page whose engagement numbers would have silently, permanently narrowed from all-time to 90-day with no UI cue, while the SAME page's report-count/streak/link-volume numbers (a separate query) stayed all-time. Confirmed with the user (**"there must be an all-time option for all... proceed without sabotaging anything"**); resolved by defaulting BOTH functions to TRUE ALL-TIME instead, justified by the plan's own prod measurement ("763ms all-time / 834ms 90-day-windowed" with the new index — all-time was never actually slower, so narrowing bought nothing). **The tuned partial+covering index WAS built on prod 2026-07-16** (deferred B6 follow-up, done): `CREATE INDEX CONCURRENTLY link_metrics_emp_url_fetched_ok_idx ON link_metrics (employee_id, url_normalized, fetched_at DESC) INCLUDE (views, likes, comments, report_date) WHERE status='ok'` — measured **12,003ms → 1,097ms (~11×)** on the leaderboard DISTINCT ON (Parallel Seq Scan + 42MB disk sort → Index Only Scan) over 2.15M rows. ⚠️ Manual index (not in a migration); the plain 3-col form IS in `schema.prisma` so `db:push` won't drop the tuned one, but a full DB restore would — re-create if `SELECT indisvalid FROM pg_index...` shows it gone. See [.planning] / memory `project_insights_perf_snapchat_completeness_2026_07_16`. `getLeaderboard`'s link count also rewritten from `include:{links:true}` (92k-row hydration) to `groupBy`; a 60s TTL cache added to the 3 heaviest leaderboard functions (mirrors `link-search.service.ts`'s `_coverageCache`, including the mandatory test-side `beforeEach(() => invalidateLeaderboardCache())` reset — this exact cross-test-pollution class already bit that sibling cache once, don't repeat it). Memory: `project_snapchat_spotlight_shipped_2026_07_15` (full record incl. two process incidents: a subagent briefly committed to the wrong git worktree — cherry-picked out and the user's branch reset cleanly with no data loss — and a stale local `main` ref that had to be re-fetched before the PR diff was trustworthy).
  - **Insights OOM + Snapchat completeness — ROOT-CAUSED 2026-07-16; the perf fix is SHIPPED (PR #100 `e0ea07d` + follow-up PR #101 `16dbe4c`, both live on prod); Snapchat display tasks (2)/(3) CLOSED 2026-07-18 by PR #104 (see the link-search/insights-perf entry below).** User reported (with screenshots) on prod: Total Engagement shows "0", leaderboard/reports slow/never-load/crash, back-nav from leaderboard→reports shows 0/crashes, Dashboard missing a Snapchat pill, Top Performers missing a Snapchat tab, Snapchat Top Links "incomplete" (mostly "—" views). All root-caused LIVE (no guessing) against `dashmani_prod`: **(1) THE BIG ONE — `getInsightsSummary()` + `getTopLinksByPlatform()` in `apps/api/src/services/social-insights.service.ts` do an UNBOUNDED `prisma.linkMetric.findMany({where})` over ALL `status='ok'` rows in a window (337,605 rows for 30d, ~70MB+ hydrated WITH a joined `employee` relation), then dedupe/sort/slice in JS — the exact OOM/timeout anti-pattern of the 2026-07-09 incident.** On the 2GB box this times out/OOMs → the request fails → the frontend falls back to `0`/empty (that's why "Total Engagement: 0" despite 760,388 rows / 10.48B views actually existing in-window), and it's the dominant cost behind the reports/back-nav crashes (the `/reports` page fires `getInsightsSummary` + 4× per-platform `getTopLinks` on load). This was the CONDITIONAL/deferred "measure then rewrite" task from PR #97 — deferred correctly then (local dev has 0 `link_metrics` rows), now measured at prod scale = broken. **Fix SHIPPED 2026-07-16 (PR #100, prod `e0ea07d`): both rewritten to SQL `DISTINCT ON (employee_id, url_normalized) ORDER BY … fetched_at DESC` mirroring `leaderboard.service.ts` — byte-identical output (13 characterization tests pass on BOTH old+new code; OLD-vs-NEW proven identical against live prod data for 30d/7d; the JS `.sort().slice()` stays so score-tie order is preserved), + a 60s `memoInsights` TTL cache with `invalidateInsightsCache()` (test `beforeEach` reset is MANDATORY — the documented cross-test cache-pollution class). OLD all-time OOM-killed the 2GB box; NEW = 12s/175MB cold, ~0.03s cached. Live-verified: Total Engagement now returns 2.77B all-time views (was "0"), P2024 = 0 across 23h+ of real traffic, the 6-concurrent-call dashboard burst that used to drain the pool returns 6×200 with the pool at 1 active/10 idle. Follow-up PR #101 (`16dbe4c`): (a) refresh-token RACE fixed in ALL THREE auth services (`auth`/`hr-auth`/`client-auth`) — concurrent refreshes with one token 500'd the loser via unhandled P2025; now `deleteMany`+count→clean 401, live-proven 8-concurrent → 1×200+7×401+0×500 (⚠️ any one-time-token consume must be `deleteMany`+count-check, never bare `delete()`); (b) `links-by-account` (`getAllAccountsLinkStats`) got the same 60s cache (was 4.1s on EVERY /reports load, cold AND warm; now 0.007s cached). Remaining KNOWN capacity characteristic (not a bug): several admins hitting DISTINCT uncached custom date-windows simultaneously queue through the 10-conn pool on the 1-vCPU box → 30-66s tails, HR polls degrade to ~3s, but everything completes 200 (graceful, never fails); mitigations if needed: bigger box / longer TTL / cron-warmed default windows. ⚠️ NEVER re-introduce an unbounded `findMany` over `link_metrics`.** **(2)** Snapchat null-views (58% of 729 `ok` Spotlight rows) is LEGITIMATE — live-probed: `/spotlight/<id>` now 301-redirects → `/p/<profileId>/spotlight/<id>`, whose `stories[0]...viewCount:"-1"` is the documented Snapchat sentinel that `snapchat-scraper.ts` CORRECTLY maps to null (Snapchat genuinely doesn't expose those counts). Plan Task 5 verifies at scale before any scraper change; Task 6 makes the UI honest ("a dash = Snapchat didn't publish a public count, not missing data"). **(3)** Dashboard Top-Performers tabs (`dashboard/page.tsx` ~146) + Links-Activity pills (~238) omit Snapchat despite 51 SC report_links/30d — small display gaps, planned Tasks 3-4. ⚠️ **Do NOT regress the previously-fixed `showLikes:false` (leaderboard) or `fmtCompact` null→"—" or all-time-default behavior.** Memories: `project_insights_perf_snapchat_completeness_2026_07_16`, `incident_2026_07_16_aslam_accounts_and_pool_exhaustion` (PR #100 full record), `project_perf_audit_refresh_race_2026_07_17` (PR #101 full record).

  - **Link Search 504 fix + insights SQL-aggregation + cooked-$queryRaw-escape prod bug + Snapchat display closure (2026-07-18 — PR #104, prod `8211128`, no `db:push`; ONE manual index op, done).** User report: "link search slow and sometimes doesn't work; top links/leaderboard must be accurate and fast; never crash under stress." All root-caused LIVE. **(1) Link Search 504:** `searchLinksByEntity` built one `url ILIKE '%<id>%'` OR-arm per entity canonicalKey — **O(keys × rows)**. "Tamannaah Bhatia" = 1,568 keys × 100k report_links → 2+ min parallel seq scan → nginx 504 at 120s, with the query still burning a pool connection afterward (caught in `pg_stat_activity`; note its `query` column truncates at 1024 chars — the visible "18 ILIKE terms" was the truncation, not the query; and "3 identical queries" with µs-identical `query_start` = 1 leader + 2 parallel workers, not 3 requests). Fixed: **SQL derived-key hash join** — the coverage-CTE CASE derives each report_links URL's canonicalKey-equivalent in one pass and joins on equality against the entity's key set (2.47s live for the 504 entity); full-URL-fallback keys via a tiny case-insensitive equality query; the JS `canonicalKey()` arbiter is unchanged and still final. ⚠️ **Never reintroduce a per-key ILIKE/contains prefilter in link-search** — the file header warns. ⚠️ **The derived CASE must mirror the JS extractors exactly** (yt: youtu.be/, any `?v=`/`&v=`, /shorts|embed|live|e/; fb: `?v=<digits>` FIRST then /reel|videos|video/<digits> — param-first matches canonicalKey's priority; sc: /spotlight/<id> ANYWHERE in path incl. resolved `/p/<uuid>/spotlight/<id>`); a review pass caught the initial CASE silently dropping /live/, fb `?v=` and /p/…/spotlight/ links (the old ILIKE matched by substring, the join requires shape-recognition — a miss = row silently gone). If `canonicalKey()` learns a new shape, update **all three CASE copies** (2 coverage CTEs + the search join) — a regression test (`derives the extended URL shapes`) locks the current set. **(2) ⚠️ Prisma `$queryRaw` tagged templates are COOKED, not raw** — JS consumes one backslash level before Postgres sees the SQL. The coverage CTEs' `watch\?v=` reached Postgres as `watch?v=` (`?` quantifies the `h`) → **`watch?v=` YouTube links were silently excluded from coverage "searchable" counts on prod since the CTEs shipped** (masked because most YT links are /shorts/, and `youtu\.be` "worked" only because a cooked `.` any-char happens to match a real dot). Every backslash in SQL regexes must be **doubled** (`\\.` / `\\?`); two link-search tests had been failing on `main` from this + fixtures that predate the 2026-06-27 intersection semantics (they seeded captions but no submitted links) — both fixed, one now locks the escaping. **(3) Top Links / insights-summary 12-16s on EVERY real visit** (60s TTL only covers same-minute bursts): PR #100's DISTINCT ON still selected columns outside the covering index (platform/url/link_id/video_id) → planner fell back to parallel seq scan + ~92MB on-disk sort + ~41k-row hydration into Node for JS aggregation. Fixed: **aggregation in SQL over index-only columns; top-N in SQL via winners-CTE + LATERAL join-back** that repeats the SAME status/platform/report_date predicates (so it fetches exactly the row DISTINCT ON picked). Requires the **v2 index, built manually on prod 2026-07-18** (`CREATE INDEX CONCURRENTLY`): `link_metrics_emp_url_fetched_ok_v2_idx (employee_id, url_normalized, fetched_at DESC) INCLUDE (views, likes, comments, report_date, platform) WHERE status='ok'` — the v1 index (without `platform`) was dropped after live verification. ⚠️ Same restore caveat as v1: not in a migration; the plain 3-col form in `schema.prisma` means `db:push` won't drop it, but a full DB restore loses it — recreate CONCURRENTLY. Measured: aggregate 14.5s→1.3s, top-20 12-16s→0.5s; **OLD-vs-NEW proven byte-identical against live prod data** (SQL `EXCEPT` both directions = 0|0 for all-time aggregates, all-time top-20 full rows, 30d IG engagement top-20). Also `limit` is clamped 1..100 in `getTopLinksByPlatform` (routes `parseInt` with no guard — NaN would otherwise bind into SQL `LIMIT` and 500). **(4) Snapchat display closure (2026-07-16 plan Tasks 3/5/6):** Top Performers gained the Snapchat tab (`/admin/reports/platform-leaderboards` already returned a snapchat board); Task 5 live-probe = **10/10 null-views Spotlights serve the `viewCount:"-1"` sentinel** at `stories[0]` → legitimate absence, NO scraper change (the `-1`→null mapping stays); the Top Snapchat Spotlights note now says a dash means Snapchat publishes no public count; Links-Activity pills needed NO change (live API already returns snapchat in `platformBreakdown` and the renderer maps all entries — plan Task 4 was moot). **Stability verdict from this session's audit:** zero crashes found — all pm2 restarts were clean deploy SIGINTs, 28-day server uptime, zero P2024 in recent logs; the remaining stress hazards (minutes-long ILIKE scans, per-call 100k-row hydrations) are the two things this PR removed. Memory: `project_link_search_insights_perf_2026_07_18`.

  - **Extraction credit-outage + FB-starvation + likes-bug — the "Facebook 1 of 19,351" incident (2026-06-26 — PRs #43/#44/#45, no `db:push`).** Next-day report: Link Search showed FB "1 of 19,351 searchable" + Top Links FB 0 ok rows. **Three real bugs, each found by going deeper (the first looked like a rate-limit, was billing):** (1) **Extraction poisoned valid captions.** `entity-extraction.service.ts` `extractOne()` set `link_content.status='error'` on ANY failure. **The prod Anthropic key is OUT OF CREDIT** (verified live — "credit balance is too low", a permanent error, NOT a transient rate-limit) → every Haiku call threw → **13,490 captions with VALID text demoted `ok→error`**, hidden from search (`buildCoverage`/`searchLinksByEntity` count `status='ok'`) + evicted from the retry selector (`status='ok' AND extractedAt IS NULL`). Fix (PR #43): **never demote status** — split TRANSIENT (429/5xx/network → `"retry"`, row pristine → retried next run) vs PERMANENT (unparseable/400/out-of-credit → `markDone()` stamps `extractedAt` to exit the queue with NO hot-loop, KEEPS `status='ok'` → still searchable); `isTransientError()` classifies both Anthropic SDK error classes AND OpenAI `Error("openai: HTTP <code>")`. **OpenAI gpt-4o-mini FALLBACK** in `defaultRawExtract` (Anthropic `maxRetries:4` first, then OpenAI raw-fetch, no SDK dep) — extraction no longer dies when one provider is broke; `OPENAI_API_KEY` added to prod `apps/api/.env` (runtime-only). ⚠️ **2 of the 3 keys the user handed over (PostAutomation Anthropic + Gemini) were ALSO out of credit — only OpenAI worked; test each handed key live before trusting.** Cron gates on EITHER key; cadence **6h→1h** (~12k/day to drain the ~25k backlog + keep up with ~1.7k/day inflow). `scripts/heal-error-link-content.ts` (dry-run-first, `--apply --confirm-prod`, idempotent, only flips rows that HAVE text — verified ALL error rows did) **healed 13,490 → FB `link_content` ok jumped 1→12,589**. (2) **FB starved in the cron.** Providers swept sequentially `[yt,ig,fb]`; IG's ~38k sweep (rate-limited, "0 IG accounts") never COMPLETED → loop never reached FB. Fix: per-provider `SWEEP_BUDGET_MS` (25min) **soft break after early harvest fires + HARD 2× backstop even if harvest never fired** (the IG-0-accounts case) → loop always advances; scoped `youTubeQuotaExceeded` to `slug==='youtube'` (was read in every provider's loop, never reset); registry order `[yt,fb,ig]` (priority belt-and-suspenders; budget is the real fix); wired the previously-DEAD `fbScraperBlocked` (scraper returns `walled:true` on login/non-200 → trips after N consecutive walls, `FB_SCRAPER_WALL_LIMIT` default 5). **Verified live: post-deploy the cron ran yt→fb→ig (FB SECOND), harvested 13,865 FB captions early, wrote FB ok engagement rows.** (3) **FB likes bug (PR #44, user-spotted from a screenshot): `likes=7476` on 46 DIFFERENT reels.** Same carousel-feed trap as `play_count` — `reaction_count` appears ~22× (one per recommended reel), first-match is a DIFFERENT reel's value. Fix: **likes parse from the og:title share-preview** ("… · 264 प्रतिक्रिया | …"), Devanagari-digit + Hindi-unit aware (ह=1e3, लाख=1e5, कोटी=1e7, + English K/M/B), **null when og:title has no reactions segment** (honest null beats a wrong carousel value). Views stay `video_view_count` (single-occ, Graph-verified), comments stay `total_comment_count` (single-occ). Verified live against the 4 worst bug reels → distinct correct likes (846/436/264/198); post-deploy FB ok rows have 88+ distinct likes, 0 bogus 7476. Nulled the 148 pre-fix stale-likes rows (kept correct views/comments) → re-scrape clean. ⚠️ **In the reel-feed HTML ONLY `video_view_count` + `total_comment_count` are target-scoped (single-occurrence); play_count + reaction_count are per-carousel-reel — NEVER first-match them; use the og:title.** (4) **Coverage-copy truthfulness (PR #45): "X of Y searchable · since 25 Jun" was read as "only links since 25 Jun exist."** Verified FALSE: Y = ALL-TIME submitted (IG 41,687 incl. 40,722 pre-25-Jun; FB 20,018 incl. 19,258 pre-25-Jun); searchable spans the historical backlog (~16k IG/13.7k FB OLD links captured); "since 25 Jun" = enrichment START date, not a cutoff. Copy rewritten: denominator is all-time, searchable counts old+new, gap = IG/FB posts scrolled past the feed window (no fetch-by-id) + opaque /share/ — "these links still exist, just can't be caption-searched." **Account Growth "Total Filmi YouTube −1.0M (−99%)" is a DATA ARTIFACT, not a real drop:** a never-live-synced account carried a stale manual 1.04M for a month, then got its first real sync (10,900) on 25 Jun via the YT follower resolver → the −99% is the correction shown as a drop; self-heals as the 30d window rolls past 25 Jun (a manual→live-correction suppressor in Top Movers is a possible future tweak). **LESSONS: rate-limited ≠ out-of-credit (check the error body live — credit is permanent); a failing LLM must NEVER corrupt its input data (separate "tagging failed" from "caption bad"); single-LLM-provider = SPOF, always have a fallback; sequential provider loops need per-provider wall-clock budgets; carousel-feed HTML needs target-scoped fields not first-match.** 99→ green test suites across the 3 PRs; incident memory: `incident_2026_06_26_extraction_credit_outage`.

  - **Link Search coverage backfills + Excel export + entity-merge durability + API Cost Sheet (2026-06-27 — PRs #55–62, no `db:push` except the additive `api_usage` table which IS already pushed).** A long owner-driven accuracy session; every round the owner verified against the real source and caught a real bug. **(A) FB caption backfill** (`scripts/backfill-fb-captions.ts`): external reels aren't on administered Pages so Graph can't reach them — only the public-reel scraper can. The cron's `fetchBatch` path was ~200 reels/hr (per-batch feed-map rebuild + sequential scrape); this script skips Graph, calls `scrapeFacebookReelEngagement()` in a concurrency pool (~11k/hr, 98% hit). Ran on prod → FB searchable captions **15,933 → 33,332**. Also fixed `enrich-link-content.ts` to host-match FB candidates (was dropping ~2,021 reels mislabeled `platform='instagram'`). **(B) IG `business_discovery` caption path** (`fetchPublicInstagramCaptions` in `meta-followers.ts` + `scripts/backfill-ig-captions.ts` + hourly `ig-caption-backfill.cron.ts`): reads captions for the ~63 EXTERNAL accounts that own ~30k uncaptioned IG links; permalink shortcode == our `ig:<shortcode>` canonicalKey. ⚠️ Meta `(#4)` app rate-limit caps it to ~1 big account/run, and the hourly cron CONTENDS with hourly follower-sync for the shared ~200-call/hr budget → most runs capture 0 (rate-limited, fast 16-23s vs 112s when it works). It chips away slowly — the accepted Meta-physics tail, not a bug. **(C) `searchable ≤ submitted` fix (the "26,467 of 22,621" impossible banner):** `buildCoverage()` counted ALL `link_content` ok rows as searchable, incl. ~12.8k FB + ~8.5k IG captions HARVESTED from administered feeds but never SUBMITTED → numerator > denominator. Fixed: searchable = INTERSECTION of `link_content(ok)` with submitted `report_links` (derive yt:/ig:/fb: id from URL in SQL, OOM-safe join). Subset-of-submitted by construction (+regression test). **(D) Entity-merge + durability** (`scripts/merge-duplicate-entities.ts`): folds same-person duplicates ("Kareena Kapoor" → "Kareena Kapoor Khan") into one canonical + aliases. TWO-STAGE conservative funnel — **the cardinal rule is NEVER merge two different people:** STAGE 1 only MULTI-TOKEN word-boundary prefixes (excludes the trap — live data: "Aditi" prefixes EIGHT different people); STAGE 2 LLM adjudicates "same person?" + skips one-to-many. **Durability (critical):** `resolveAndPersist` now resolves by canonicalName OR ALIAS before creating — without it the live extraction cron RE-CREATED merged-away entities (the merge silently undid itself). Search resolves a multi-exact-match (name == one entity's canonicalName AND another's alias) to the entity with the MOST links, never loops (the post-merge disambiguation-loop bug). **(E) `@@` handle fix:** a stored `social_accounts.handle` with a leading "@" rendered as "@@" — fixed at render (`fmtHandle`), write boundary (`sanitizeAccountHandle` strips "@"), + `scripts/normalize-account-handles.ts` (13 prod rows). **(F) Link Search Excel export:** "Export to Excel" button → `link-search-export.service.ts` (xlsx-js-style) Posts sheet (date/platform/channel/submitted-by/URL/dup, same-vs-unique preserved) + About sheet; `GET /admin/link-search/export.xlsx`. **(G) API COST SHEET (`/api-costs`, sidebar "API Costs"):** `api-usage.service.ts` `recordApiUsage()` (FAIL-OPEN fire-and-forget) writes one `api_usage` row per call at the TRUE chokepoints (3 LLM providers per-call w/ tokens, `ai.service` askClaude, `meta-graph.ts` graphFetch = ALL Meta, `youtube-followers.ts` safeFetch +quota-units, `youtube.provider.ts`, `facebook-scraper.ts`). `getCostSheet(days)` aggregates. **The accuracy saga + lessons (each a real owner-caught bug):** (1) **a reconstructed estimate is NOT a measurement** — backfilling history from `link_content.extracted_at` × flat rate OVER-counted incident days ($55.98 for Jun 26 vs OpenAI's real $33.74); deleted the reconstructed dollar rows, headline = MEASURED only, never claim "30 days" on younger data (`fullWindow`/`trackingSince`). (2) **prompt caching** — our extraction prompt's stable prefix (system + known-entities list, caption varies at END) is auto-cached by OpenAI at HALF; charging full overstated ~40%; `llmCostUsd` takes `cachedTokens`, capture `prompt_tokens_details.cached_tokens`. (3) **don't presume the projection** — it was measuring the cron at CATCH-UP speed (draining backlog) not steady state; gated on `pendingExtractionBacklog` (>2000 → `projectionReliable:false`, UI shows "—"). (4) **SHARED OpenAI key** — PROVEN from the owner's official cost export: ALL spend on ONE `api_key`/project/org ("Post Automation"), dashmani + the OTHER app; OpenAI itself can't split them; dashmani only extracted from Jun 23 so ~$67 of the $110 May26-Jun27 total is the other app, dashmani ≈ $40-45 (mostly the one-time backfill). **Authoritative = OpenAI Costs API** (`openai-costs.service.ts` `fetchOpenAiBilling` → `GET /v1/organization/costs`, `Bearer OPENAI_ADMIN_KEY`, paginated; DARK+FAIL-OPEN; UI "OpenAI — Billed (authoritative)" panel labeled COMBINED). ⚠️ **PENDING USER ACTION: the authoritative panel is DARK until `OPENAI_ADMIN_KEY` (sk-admin-… with `api.usage.read` scope, generated at platform.openai.com → Settings → Admin keys) is added to prod `apps/api/.env` + `pm2 restart api`.** Cannot be generated programmatically (needs the owner's OpenAI login). The by-key breakdown means a future DEDICATED key auto-isolates dashmani with no code change. ⚠️ **Anthropic key still OUT OF CREDIT on prod** (live 400) — connected but a dead fallback; order is OpenAI→Gemini→Anthropic. Memories: `project_link_search_coverage_2026_06_27`, `project_api_cost_sheet_accuracy`.

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
- **Link Entity Search shipped — YouTube-first (2026-06-23, PR merge `1fbbb96`):** Admin can search uploaded links by *who/what the post is about* (e.g. "Salman Khan") → see **total posts / unique posts / duplicate posts / channel count** + an honest coverage banner. Internal portal sidebar → **Link Search** (`apps/internal/src/app/reports/link-search/page.tsx`). **3-stage pipeline, reuses the social-insights provider/cron architecture (NOT a parallel system):** ① **enrich** — `link-content.service.ts` `upsertLinkContent()` stores caption/title in the new `link_content` table keyed on `canonicalKey()` (one row per unique post); the YouTube provider now fetches `part=statistics,snippet` (same batched call — metric mapping byte-identical, captions ride along free), and the existing `social-insights.cron.ts` writes content in an **independently try/catch-guarded** block AFTER the metric write (a content failure can never affect metrics). ② **extract** — `entity-extraction.service.ts` sends captions to **Claude Haiku** (`claude-haiku-4-5-20251001`, same Anthropic pattern as `ai.service.ts`) → resolves to **canonical `Entity` rows** (aliases lowercased + deduped race-safely via `ARRAY(SELECT DISTINCT unnest(array_append(...)))`); idempotent (selector `status='ok' AND extractedAt IS NULL`, cap 500/run) so it **extracts once, never re-pays**; defensive JSON parse → a malformed LLM reply marks that row `status='error'` and is skipped forever, never throws the batch. New isolated 6h `entity-extraction.cron.ts` in `index.ts` (no-ops without `ANTHROPIC_API_KEY`). ③ **search** — `link-search.service.ts` `searchLinksByEntity()` → routes `GET /admin/link-search` + `GET /admin/entities` (admin-reports.routes.ts, `requirePermission("reports","view")`). **OOM-SAFE (critical):** never load all ~59k report_links into Node; the query is bounded to the matched entity's `canonicalKey` set via a DB-level `url contains <id-part>` OR-filter, then the exact JS `canonicalKey()` is the final arbiter on the tiny candidate set. **Same-vs-unique is a hard requirement** — results show every row grouped by `canonicalKey` with `dupCount`, never collapsed. **3 new additive tables:** `entities` (canonicalName unique, aliases String[]), `link_content` (canonicalKey unique, title/caption, status, extractedAt — **NO FK to report_links**, joined by canonicalKey on read), `link_content_entities` (join). **Prod backfill applied 2026-06-23:** 1,917/1,941 YouTube links enriched (24 unparseable titles), 566 entities (438 PERSON / 90 TOPIC / 23 BRAND / 15 OTHER), 4,416 tags; verified live (`Kriti Sanon`→64 posts/3 channels). Backfill scripts: `scripts/enrich-link-content.ts`, `scripts/extract-entities.ts` (both dry-run default, `--apply`). **Known data-quality note:** extraction also tags channel names ("Total Filmi") + places ("Bandra") as BRAND/TOPIC (prompt asked for people+brands+topics); 77% are PERSON; optional future tune = tighten prompt / default UI to PERSON, re-run extraction (idempotent). **Instagram/Facebook (in progress 2026-06-23):** same pipeline; fill the two provider stubs + add Meta System User token to `apps/api/.env` + flip `SUPPORTED_INSIGHT_PLATFORMS` — no search-side change. Spec: `docs/superpowers/specs/2026-06-22-link-entity-search-design.md`; plan: `docs/superpowers/plans/2026-06-22-link-entity-search.md`.
- **Why a free crawler is NOT used for IG/FB captions (decided 2026-06-23):** Tempting but rejected for *this* codebase's reality — (1) ~27k IG/FB links from one server IP → Instagram/Facebook **IP-ban** fast; (2) IG/FB serve captions only to **logged-in** sessions now (logged-out crawl hits a login wall; logged-in scrape = ToS violation + account ban); (3) the renderer needed for IG's JS would **OOM the 2GB Linode** that already OOM-kills the `internal` build. The **free Meta Graph API** is both the permanent AND quickest reliable path — the caption comes in the SAME call as engagement metrics. **Opaque Facebook links** (`facebook.com/share/r/<code>` — ~16,837 of FB links on prod, ~84%) carry a redirect *share token*, not a post ID, and redirect to an equally-opaque `pfbid…` permalink the Graph API can't query; clean `/reel/<numericId>` (~3,123) IS resolvable. **Two-part fix (decided 2026-06-23):** (1) a **cheap best-effort HEAD-redirect** recovers only opaque links that redirect to a clean numeric URL (gives up on `pfbid` — no fragile feed-matcher); (2) **the durable fix is submit-time prevention** — resolve a `/share/` link's redirect *once, at submission* (when it's fresh + cheap) and store the clean URL, so future FB links come in queryable. Submit-time resolution MUST be additive + **fail-open** (any throw/timeout → keep original url; never block/slow the load-bearing HR submit; do it OUTSIDE the `$transaction`). Coverage banner stays honest about the unrecoverable historical opaque tail. Full analysis: `.planning/FB-INSTAGRAM-INSIGHTS-PLAN.md`; remaining-work spec: `docs/superpowers/plans/2026-06-23-ig-fb-futureproof-handoff.md`.
- **HR report draft auto-save (shipped 2026-05-30):** Server-side draft stored in `report_drafts` table (keyed on employeeId + dateKey). Auto-saves debounced 3s after any change. Works before AND after submit — if employee adds more links after submitting and closes the tab, those additions are restored on next page load (draft timestamp vs submitted report timestamp determines which wins). Draft cleared on successful submit. `PUT/GET/DELETE /hr/reports/draft` endpoints on `authenticateHr` middleware.
- **Cross-day duplicate links now silently dropped (2026-05-30):** `submitDailyReport()` in `daily-report.service.ts` previously threw 400 DUPLICATE_LINKS when any submitted link existed in a previous day's report. Now silently filters them out before inserting, matching the frontend auto-dedupe behaviour. Frontend also re-arms cross-day dedupe after every Smart Paste. Fixes Kanishka-style "already submitted" hard block.
- **Added-links-vanish-on-resubmit fixed (2026-06-04, the "Anish" bug):** Heavy *incremental* submitters (e.g. 181 links saved, paste +22 more, resubmit) lost the additions — the POST returned 201 but only the original set persisted, and the count reverted on hard refresh. **Root cause was CLIENT-side, not the server.** In [apps/hr/src/app/report/page.tsx](apps/hr/src/app/report/page.tsx), `handleSubmit`'s resubmit branch did `draftRestoredRef.current = false; setPrefilled(false)` to "re-arm" the restore effect. But that effect is keyed on `[todayData]`, and the `await mutateToday()` just above it changes `todayData` → the restore effect **re-ran and `setLinks(existing.links)` clobbered the live form** (base + freshly-pasted) with the stale server snapshot *before* the additions were ever sent. Proven via prod forensics: the surviving links' `firstSeenAt` stopped exactly at the last pre-clobber moment; the server is correct (a single POST of the full set always persists the full set — see the "Anish scenario" + "removal still works" integration tests in `daily-report.test.ts`). **The fix (three client-side changes, server untouched):** (1) **removed the harmful re-arm** — auto-save still works because its guard only needs `draftRestoredRef.current === true`, which stays true; (2) **`formIsPristine()` guard** on all three restore/prefill `setLinks` calls so restore can never overwrite a form that already holds user content (defense-in-depth); (3) **payload snapshot** (`payloadLinks`/`payloadNotes`) captured before the geolocation `await` so a mid-submit paste/restore can't change what's POSTed; plus an `if (loading) return` **in-flight guard** in `handleSubmit` (the `disabled={loading}` button is cosmetic — Enter/rapid taps re-enter). **Deliberately NOT changed:** the server delete-and-recreate transaction stays as-is (it's correct and load-bearing; intentional link *removal* relies on it — a "merge/additive" server fix would break removal, metric edits, and scheduled-link cleanup). The server TOCTOU race (two overlapping POSTs → last-writer-wins) is a known *secondary* hazard now largely closed by the in-flight guard; left for a future dedicated change with load testing rather than bundling a risky Serializable-isolation rewrite into a hotfix. Frontend-only, no `db:push`.

- **"86 → 84 on Update with no message" — duplicate-skip now explained at submit time (2026-06-22, PR #33, commit `35ba986`):** A *different* report than the 2026-06-04 Anish bug, raised again by Anish (video). Symptom: 42 already submitted → paste +44 → form shows 86 → click **Update Links** → "Submitted" shows **84**, with **no duplicate-removal message**, so the user assumes 2 links were lost (not duplicates). **It is NOT data loss — it is de-dupe working correctly.** Proven read-only against prod: Anish's 2026-06-20 report = **423 links, 423 distinct `canonicalKey`s, 0 collisions, 10 clean incremental batches** — nothing lost. The "missing" 2 were **genuine duplicate Instagram reels** (same reel re-copied with a fresh `?igsh=` token → collapsed by `canonicalKey()`). This is *Phenomenon 1* of the 2026-06-05 analysis (legitimate dedupe), **not** the 2026-06-04 incremental-loss bug. **Root cause of the confusion:** the paste-time dedupe toast **auto-dismisses after 6s** ([report/page.tsx](apps/hr/src/app/report/page.tsx) `pushDedupeNotice`), and the user scrolls through dozens of rows to verify before clicking Update — so by submit time there is no on-screen explanation for the lower count. **The fix (additive, no logic/transaction change):** (1) **Server** [daily-report.service.ts](apps/api/src/services/daily-report.service.ts) `submitDailyReport` snapshots the live-link count (`!isScheduled && url.trim()`) at each existing dedupe boundary and returns an **additive** `dedupe: { inSubmission, crossDay, total }` sibling on the `POST /hr/reports` response *only* (purely observational — `formatReport`, used by all read paths + admin, is untouched). (2) **Shared** [types/hr.ts](packages/shared/src/types/hr.ts) gets an **optional** `dedupe?` field (non-breaking for every reader). (3) **Client** derives the headline saved/skipped count by **diffing the POST response's saved links vs the submitted snapshot** (so it can never disagree with the count the user sees; the server reason-split is *optional enrichment* for copy), and renders a **persistent** emerald summary directly above the submit button — *"84 links saved · 2 duplicates skipped — no links were lost · 2 already in your submitted list"* — **no auto-dismiss**, cleared on the next edit/paste; on a first submit with drops it now **stays on the page** (instead of redirecting to /dashboard) so the user reads it. **Bundled follow-ups:** (a) **client cross-day window 60d → 90d** to match the server's `CROSS_DAY_WINDOW_DAYS=90` — closes a gap where the server could silently drop a 61–90-day-old dup the client never flagged (now caught + explained); (b) **removed the dead, shadowed (and unvalidated) duplicate `POST/GET /hr/reports` handlers in [hr-features.routes.ts](apps/api/src/routes/hr-features.routes.ts)** — `hr.routes.ts` mounts first (see `routes/index.ts`) and always wins; left a breadcrumb comment so they aren't re-added. **Deliberately NOT touched:** the delete-and-recreate `$transaction`, the prior Anish-bug restore-effect guard, `payloadLinks` snapshot, `if (loading) return`. Tests: +4 `dedupe`-count assertions; **45/45** daily-report + canonical-url green incl. all canaries. `tsc` clean (api+shared+hr), full HR build passes, verified live on prod (health + shipped `/report` bundle contains the new copy). **No `db:push`.** ⚠️ Don't "fix" a future 86→84 report as data loss without first checking the stored report's `canonicalKey` collisions — a clean −N with no message is almost always correct dedupe + the (now-replaced-at-submit) 6s toast.

- **DB connection-pool crash-loop — the "unexpected error" incident (2026-07-08/09, PRs #84 + #85):** HR `/report` submit showed *"An unexpected error occurred"* (Fareen + others) and portals intermittently 502'd. **Root cause: `new PrismaClient()` with no `connection_limit` in `DATABASE_URL` → Prisma defaulted the pool to `num_cpus*2+1` = 3 on the 1-vCPU box.** Under submit load the 3-conn pool saturated → `P2024` timeouts; one **unguarded `await` in `requirePermission` (`rbac.ts`)** turned each P2024 into an **uncaught rejection → full-process crash-loop** (Express 4 doesn't catch async-middleware rejections; 152 lifetime crashes). **PR #84 (prod `16024f1`, no db:push):** (1) `packages/db/src/index.ts` `withConnectionPool()` appends `connection_limit=10&pool_timeout=20&connect_timeout=15` to `DATABASE_URL` in CODE (fail-open; an explicit value in the URL wins) — safe on every env; (2) `asyncHandler` (`apps/api/src/utils/async-handler.ts`) wraps `requirePermission` so a DB error → handled 500, never a crash; `process.on('unhandledRejection'/'uncaughtException')` backstops in `index.ts` (log, do NOT `exit`); (3) report-link `url` validator capped at `.max(2048)` → clean 400 instead of an unhandled Postgres btree `54000` on a >2704-byte URL; (4) `getAllReports` paginated (`take`/`skip`, default 50 / max 100) + reports-UI Prev/Next + per-card 20-link cap. **Manual prod step (done):** appended the params to prod `apps/api/.env` `DATABASE_URL` + `pm2 restart api` (runtime-only; deploy.sh only rewrites `apps/*/.env.local`, NOT `apps/api/.env`, so it survives deploys). ⚠️ **Never revert `withConnectionPool` or the `rbac.ts` `asyncHandler` guard** — pool=3 + an unguarded middleware `await` is the exact crash-loop.

- **HR `/report` mobile overflow + iOS zoom + submit-redirect + robust paste + `getReportSummary` OOM (2026-07-09, PR #85, prod `e6261e4`, no db:push):** Follow-up to the incident above; the OTHER half + the mobile reports. **⚠️ None caused by PR #84** (it touched 0 `apps/hr` files). Fixes: (1) **iOS auto-zoom cut-off** — `apps/hr/src/app/globals.css` touch-device input font floor restored **14px→16px** (PR #83 had lowered it below iOS Safari's 16px auto-zoom threshold; focus zoomed + horizontally panned the viewport so metric fields / Auto-Sort / the per-link trash button went off-screen; Android never zooms → the "only certain users" was **iOS-only**). ⚠️ **Never drop a focusable `input/textarea/select` below 16px on touch** — style labels/helper text directly instead. (2) **Account `<select>` overflow** — the "Assign all to" + per-link account selects were forced past a ~390px viewport by long handles (**174 prod accounts polluted with `?igsh=…` tracking tokens**, up to 46 chars); `min-w-0` alone is NOT enough because a `<select>`'s intrinsic width = its longest option. Fix: `w-full max-w-full` + a **display-only** `accountOptionLabel()` (strips `?query`, drops leading `@`, caps ~24 chars) — **data untouched**. (3) **Submit STAYS on `/report`** — removed the clean-first-submit `router.push('/dashboard')`; it now always stays + shows a persistent success banner and the "Submitted today" panel updates in place (the historical/expected behavior — a redirect read as "it failed"). `router.push` now lives ONLY on the Cancel button. **Load-bearing submit/dedupe/draft transaction untouched.** (4) **Robust Smart Paste** — the strict `new URL()` filter silently dropped bare `instagram.com/…` (no scheme), numbered lists, trailing commas; new `normalizePastedUrl()` recovers them (**verified a STRICT SUPERSET of the old parser — 0 regressions** across a month's realistic inputs) and reports unparseable lines ("N line(s) skipped") instead of dropping silently. ⚠️ **`new URL()` is engine-divergent — browsers PERCENT-ENCODE spaces so `new URL("https://not a link")` SUCCEEDS in-browser (Node rejects it)**; the no-whitespace + dotted-host guards are load-bearing, caught ONLY by live browser test. Paste panel now defaults open, no auto-collapse. (5) **`getReportSummary` bounded (the 502)** — [daily-report.service.ts](apps/api/src/services/daily-report.service.ts) was an UNBOUNDED `findMany({ include: { links } })` hydrating **84k+ `report_links` rows** into Node heap (PR #84 paginated only `getAllReports`, not this) → ~1.7GB RSS → the kernel OOM-killer reaped a portal (the self-resolved 502 was a **runtime** OOM, NOT the deploy build). Now fetches reports without links + a DB `groupBy(reportId, platform)` for counts — **byte-identical output** (new multi-platform/multi-day regression test; 39/39 daily-report green). ⚠️ **Never re-introduce an unbounded `findMany({ include: { links } })` in any reports READ path.** (6) **Ops safety net (prod-side):** `pm2 max_memory_restart=500M` set on all 5 processes + `pm2 save` — a runaway heap restarts THAT process instead of the kernel killing a random portal (normal RSS ~18MB, so 500M is generous headroom vs the ~1.7GB that triggered the kill). It's in `dump.pm2` (survives `pm2 restart all` / `pm2 resurrect`); the durable long-term home would be an `ecosystem.config.js` (deploy.sh currently uses bare `pm2 restart all` + `pm2 save`, no ecosystem file). Full detail: `docs/superpowers/plans/2026-07-09-db-pool-exhaustion-crash-loop.md` (PR #84 half). ⚠️ **A fresh `git worktree` has no `node_modules` and no gitignored `.env*`** — run `npm install` + copy `.env`/`packages/db/.env`/`apps/api/.env` + write `apps/hr/.env.local` before tsc/tests/dev, or you get phantom "type missing" / "DATABASE_URL not found" errors that look like code bugs.

- **Entity extraction is now DeepSeek-only, with prompt caching + a hard spend ceiling (2026-07-15, plan `docs/superpowers/plans/2026-07-15-deepseek-extraction-migration.md`, no `db:push`).** Replaces the prior GEMINI-ONLY extraction state (`project_extraction_gemini_only_2026_06_29`) — Gemini/OpenAI/Anthropic are removed from the active `defaultRawExtract` chain (their price rows in `api-usage.service.ts` are deliberately KEPT for historical cost recompute on the ~90k already-extracted rows). **Sole provider: `deepseek-v4-flash`, non-thinking mode** (`{"thinking":{"type":"disabled"}}` sent explicitly in the raw-fetch body — DeepSeek defaults thinking to ON, which bloats output tokens; ⚠️ never remove that flag). **Cache-on via a stable system prefix:** the entity-list + instructions moved into a system message that is only rebuilt **once per batch of 50 new entities** (not per call, not per row) — DeepSeek's on-disk cache (on by default, no storage fee) then hits on the byte-identical prefix, billing cache-hit input at $0.0028/M instead of the $0.14/M miss rate. ⚠️ **Never re-inline the (growing) entity list into the per-call user prompt** — that was the original bug that made every call a fresh prefix and killed the cache; the varying caption lives in the user message, the stable list lives in the system message. **Peak-pricing multiplier:** DeepSeek doubles price during UTC **01:00–04:00 and 06:00–10:00** (2×); `api-usage.service.ts`'s cost computation and `recordApiUsage` apply the multiplier so recorded cost reflects the hour the call actually ran in, not a flat rate. **Hard daily spend ceiling:** `extraction-spend.service.ts` computes today's (UTC-day) DeepSeek spend from `api_usage` and enforces `extraction.spendCeilingUsd` (`system_settings`, default **$3**) — the cron (`entity-extraction.cron.ts`) checks it at run-start AND mid-batch, and gates on `DEEPSEEK_API_KEY` being present (replacing the old three-key OR-gate); admins can view/edit the ceiling via `GET`/`PUT /admin/extraction/spend-ceiling` and the `/api-costs` UI panel, which also surfaces the existing `enrichment.enabled` kill-switch as a visible toggle alongside a DeepSeek cost/cache panel. **Backlog drain:** the ~22–23k-caption backlog was drained off-peak after live-verifying the cache was actually hitting (a hard-stop gate — if the cache isn't hitting, the drain halts before spending materially); expected full-backlog cost ~$2.50 with cache on vs a $133.91 worst-case (no-cache, all-peak) that the ceiling + off-peak drain + live cache-verification make unreachable. ⚠️ **These three rules are load-bearing — do not regress any of them:** (1) never re-inline the entity list per-call (kills the cache); (2) never remove `thinking:{type:"disabled"}` (bloats output cost); (3) never widen or bypass the spend-ceiling check without re-doing the overspend arithmetic above.

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
