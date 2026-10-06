# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A Turborepo + npm-workspaces monorepo: one Express REST API, four Next.js portals (internal staff, client, HR, public jobs) and the public marketing site on a shared PostgreSQL database through Prisma, plus shared TypeScript packages and a separate Expo mobile app.

## Repository layout

| Path | Purpose |
|---|---|
| `apps/api` | Express REST API (`@dashmani/api`, port 4000) — the only backend |
| `apps/internal` | Internal staff / management portal, Next.js (`@dashmani/internal`, port 3000) |
| `apps/client` | Client portal, Next.js (`@dashmani/client`, port 3001) |
| `apps/hr` | HR / employee portal, Next.js (`@dashmani/hr`, port 3002) |
| `apps/jobs` | Public jobs portal, Next.js (`@dashmani/jobs`, port 3003) |
| `apps/web` | Public marketing site digitalsukoon.com, Next.js static export (`@dashmani/web`, dev port 3004) — served by nginx from `apps/web/out`, no pm2 process |
| `packages/db` | Prisma schema and client (`@dashmani/db`) — the single source of truth for the database |
| `packages/shared` | Zod validators, types and utilities shared by the API and the portals (`@dashmani/shared`) |
| `packages/ui` | Shared Radix UI + Tailwind components (`@dashmani/ui`) |
| `mobile` | Expo / React Native app (not part of the npm workspaces) |
| `scripts` | Operational and one-off scripts (deploy, backfills, feature DDL) |
| `nginx` | Reverse-proxy site configuration |

## Commands

Run from the repo root unless noted.

```bash
npm install                    # all workspaces
docker-compose up -d           # local PostgreSQL 16 + Redis 7

npm run db:generate            # regenerate the Prisma client (after any schema change)
npm run db:push                # sync schema.prisma to the LOCAL database
npm run db:seed                # roles, an admin user, platforms, demo data

npm run dev                    # every app in parallel (Turbo)
npm run dev -w @dashmani/api   # a single app
npm run build                  # build every app
npm run lint

# API tests (Vitest) — run from apps/api, not the repo root
cd apps/api && npx vitest run
```

Environment: `.env` (root), `apps/api/.env` and `packages/db/.env` start from `.env.example`. Each portal reads `NEXT_PUBLIC_API_URL` from `apps/<app>/.env.local` (locally `http://localhost:4000/v1`); it is baked into the bundle at build time.

## Architecture

### API (`apps/api`)
- `src/app.ts` builds the Express app: helmet → cors → rate limiting → JSON parsing → routes under `/v1` → error handler. `src/index.ts` starts the server and the background jobs.
- `src/routes/` hold HTTP handlers; business logic lives in `src/services/`; background jobs in `src/cron/`; middleware in `src/middleware/`.
- Three authentication middlewares, one per portal: `auth.ts` (internal staff), `hr-auth.ts`, `client-auth.ts`. Authorization is role-based (`rbac.ts`): permissions are `{resource}.{action}.{scope}` with scope `own | team | department | global`, stored in the database (`Role`, `UserRole`, `RolePermission`).
- Every response uses the envelope `{ success: boolean, data | error }`.
- Third-party integrations live under `src/services/` — e.g. `meta-oauth/` (Meta Graph API: connected Pages / Instagram accounts, channel and post syncs, posting watch) and `social-insights/` (link engagement metrics).

### Frontends (`apps/internal`, `apps/client`, `apps/hr`, `apps/jobs`)
- Next.js App Router, SWR for data fetching, Tailwind CSS, `@dashmani/ui` components.
- Each app has its own API client in `src/lib/api.ts` (`apiFetch`) and its own token storage; the portals are independent and share no pages.
- `apps/jobs` is public and renders job pages on the server (Server Components) for search indexing; the other portals are authenticated client-side apps.

### Database (`packages/db`)
- All schema changes go through `packages/db/prisma/schema.prisma`; run `npm run db:generate` afterwards so every workspace sees the new types.
- The project uses `prisma db push` locally (no migration history). Production schema changes are applied with reviewed SQL scripts in `scripts/`.

### Shared code (`packages/shared`)
- Zod validators in `src/validators/` are used by the API for input validation and by the portals for forms.
- `safeString` (sanitised free text), `normalizedEmail`, `formatStatus()` (enum → "Title Case") and the IST date helpers (`todayIST()`, `dateToIST()`, …) live in `src/utils/`. "Today" is always the India (IST) calendar day.

## Conventions

- API routes are versioned under `/v1/`; business logic belongs in services, not route handlers.
- Use the shared validators instead of redefining them in an app; use `safeString` for user-supplied text.
- Public endpoints return explicit Prisma `select`s, never whole rows.
- The working week is Monday–Saturday (Sunday is the only weekend day).
- The API test setup truncates every table before each test — point `DATABASE_URL` at a dedicated test database when running it.
