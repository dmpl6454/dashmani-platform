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
