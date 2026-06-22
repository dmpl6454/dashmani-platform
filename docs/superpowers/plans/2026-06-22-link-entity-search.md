# Link Entity Search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin search uploaded links by who/what the post is about (e.g. "Salman Khan") and see total posts, unique posts, duplicate posts, and how many channels — across ~27k `report_links`.

**Architecture:** A 3-stage pipeline reusing the existing `social-insights` provider/cron architecture: ① **Enrich** (fetch caption/title per unique post, keyed on `canonicalKey()`) → ② **Extract** (Claude Haiku reads caption → canonical `Entity` rows, idempotent) → ③ **Search** (admin endpoint + internal-portal UI). Ships **YouTube-first** (431 links, fetchable today); Instagram/Facebook flow through the same pipeline when the Meta token lands. Additive-only schema; existing metrics pipeline, submit path, and `SUPPORTED_INSIGHT_PLATFORMS` switch are untouched.

**Tech Stack:** Prisma (Postgres, `db push`), Express + TypeScript (apps/api), Anthropic SDK (Haiku), Next.js App Router + SWR + @dashmani/ui (apps/internal), Vitest (integration).

**Spec:** `docs/superpowers/specs/2026-06-22-link-entity-search-design.md`

---

## ⚠️ READ FIRST — Safety corrections from adversarial review

This plan was reviewed by an adversarial "can this break a working portal?" pass that found **6 HIGH + 9 MEDIUM** issues. **The fixes are NOT optional** — they are folded into the task notes inline and listed in full in the **"Safety Corrections" appendix at the end**. The four that matter most:

1. **Schema additive-gate was self-defeating** (HIGH): the `prisma migrate diff | grep || echo "ADDITIVE-ONLY"` printed the reassuring message *when the diff command itself errored* (relative path fails from repo root). Run the diff **from `packages/db`** with `set -o pipefail`, and invert the grep to flag **ANY** `ALTER`/`DROP` on a table that is not one of the three new ones.
2. **Search would OOM the API on prod** (HIGH): never load all ~30k `report_links` into Node and filter in app code. Constrain the `ReportLink` query to the matched entity's `canonicalKey`s (tens–hundreds) **in the DB**, and push date/platform filters into the query.
3. **Test-suite landmine** (HIGH): do **not** add the new tables to `tests/setup.ts`'s shared `TRUNCATE` until `db:push` has created them — a missing-table `TRUNCATE` aborts `beforeEach` and turns **every** existing test red. Guard the new-table truncate in its own try/catch.
4. **Route-ordering tests that pass for the wrong reason** (MEDIUM): `authenticate` 401s before the handler, so a tokenless curl can't prove ordering. Make the smoke curl **authenticated**; and note that `/admin/link-search` and `/admin/entities` differ from `/admin/reports/:reportId` in the 2nd path segment, so `:reportId` can never capture them regardless of order (placement is convention, not capture-avoidance).

---

## Task 0: Establish a clean-build + clean-DB baseline (DO THIS FIRST)

**Why:** A later full `npm run build` rebuilds every app. If an unrelated app has a latent break or a stale `apps/*/.next`, a literal implementer will misattribute it to this feature (the 2026-05-19 incident). Capture a green baseline now so any later failure is provably ours.

- [ ] **Step 1: Clean tree + full build baseline.** Do NOT run while dev servers are up (poisons `.next`).
  Run: `cd /Users/tabish/Desktop/dashmani-platform && lsof -ti:4000,3000,3001,3002,3003 | xargs kill -9 2>/dev/null; npm run build`
  Expected: `Tasks: N successful, N total`, zero `ERROR` lines. If it FAILS on a clean tree, STOP — the break is pre-existing, not this feature; fix or report that first.

- [ ] **Step 2: Confirm Docker Postgres is healthy.**
  Run: `docker ps --format '{{.Names}}\t{{.Status}}' | grep dashmani-db`
  Expected: `dashmani-db ... (healthy)`. If absent: `docker-compose up -d`.

- [ ] **Step 3: Confirm the local DB is in sync with HEAD's schema (no pre-existing drift) BEFORE editing schema.prisma.**
  Run: `cd /Users/tabish/Desktop/dashmani-platform/packages/db && set -o pipefail; npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code; echo "exit=$?"`
  Expected: `exit=0` (empty diff — DB already matches schema). If non-zero, the local DB has drift unrelated to this feature; run `npm run db:push` from root first, then re-check. (This makes the Task-in-Phase-A additive-diff trustworthy.)

- [ ] **Step 4: Baseline the API test suite** (so the ~36 known pre-existing failures don't get blamed on us).
  Run: `npm run test -w @dashmani/api 2>&1 | tail -20`
  Expected: note the count of pre-existing failures (analytics/content/task/team per CLAUDE.md). New tests added by this plan must pass on their own; the baseline failures must not increase.

---

## Phase ordering (strict dependency chain)

Implement **A → B → C → D → E in order.** Each depends on the prior:
- **E (UI)** Tasks for code+build are safe anytime, but its **smoke test is BLOCKED until D ships** — at the top of E's smoke task: `grep -rn link-search apps/api/src/routes/` must return the route, else STOP. **Do NOT create API routes from the UI phase.**
- Do **not** edit `apps/api/tests/setup.ts` to add the new tables until **Phase A's `db:push` has actually run** against the local DB (see HIGH finding #3).

---

## Phase A — Database schema (additive)

### Task 1: Append the three new models to schema.prisma

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (APPEND after line 1371 — the end of the `// ============ SOCIAL INSIGHTS ============` section, immediately after the `LinkMetric` model's closing `}`. Do **not** edit any existing model.)

Steps:

- [ ] **Step 1:** Confirm the file currently ends at the `LinkMetric` model so the append lands at the true tail (no trailing models hidden below):
   ```bash
   cd /Users/tabish/Desktop/dashmani-platform && tail -n 3 packages/db/prisma/schema.prisma
   ```
   Expected output (the closing of `LinkMetric`):
   ```
     @@index([platform, fetchedAt])
     @@map("link_metrics")
   }
   ```

- [ ] **Step 2:** Append the three new models verbatim (the only edit to this file). Use the Edit tool to replace the final `LinkMetric` closing block with itself plus the new section. `old_string`:
   ```prisma
     @@index([platform, fetchedAt])
     @@map("link_metrics")
   }
   ```
   `new_string`:
   ```prisma
     @@index([platform, fetchedAt])
     @@map("link_metrics")
   }

   // ============ LINK ENTITY SEARCH ============
   // Additive-only feature (CREATE TABLE only — no ALTER/DROP on existing tables).
   // LinkContent has NO FK to ReportLink: the join is by canonicalKey() computed on
   // read (same philosophy as link dedupe — raw URLs stay in report_links, the key
   // is derived). Survives the report_links delete-and-recreate churn with zero re-linking.

   model Entity {
     id            String   @id @default(uuid())
     canonicalName String                       // "Salman Khan"
     type          String   @default("PERSON")  // PERSON | TOPIC | BRAND | OTHER
     aliases       String[]                      // ["bhaijaan","sallu","beingsalmankhan","सलमान"]
     createdAt     DateTime @default(now()) @map("created_at")
     updatedAt     DateTime @updatedAt      @map("updated_at")

     links         LinkContentEntity[]

     @@unique([canonicalName])
     @@index([type])
     @@map("entities")
   }

   model LinkContent {
     id           String    @id @default(uuid())
     canonicalKey String                          // ig:CxYz / yt:dQw4 / fb:123 / full-url fallback
     platform     String                          // classified by URL, not the dirty platform column
     title        String?   @db.Text              // YouTube title
     caption      String?   @db.Text              // IG/FB caption (and YouTube description)
     status       String    @default("pending")   // pending | ok | not_found | private | unsupported | error
     extractedAt  DateTime? @map("extracted_at")  // null until stage 2 runs; set when entities extracted
     fetchedAt    DateTime? @map("fetched_at")    // when caption/title last fetched
     createdAt    DateTime  @default(now()) @map("created_at")
     updatedAt    DateTime  @updatedAt      @map("updated_at")

     entities     LinkContentEntity[]

     @@unique([canonicalKey])
     @@index([status])
     @@index([extractedAt])
     @@map("link_content")
   }

   model LinkContentEntity {
     id            String      @id @default(uuid())
     linkContentId String      @map("link_content_id")
     entityId      String      @map("entity_id")
     confidence    Float       @default(1.0)

     content       LinkContent @relation(fields: [linkContentId], references: [id], onDelete: Cascade)
     entity        Entity      @relation(fields: [entityId],      references: [id], onDelete: Cascade)

     @@unique([linkContentId, entityId])
     @@index([entityId])
     @@map("link_content_entities")
   }
   ```
   Note: `@map("extracted_at")` / `@map("fetched_at")` are added (the spec's prisma block omitted them, but every snake_case timestamp column elsewhere in this schema is `@map`-ed — e.g. `link_metrics.fetched_at` at the file tail — so these match the repo convention). The new tables introduce **zero relation fields on existing models** (the `LinkContent ←→ ReportLink` join is by `canonicalKey` on read, by design — spec §4 note), so no existing model is touched.

### Task 2: Validate the schema and regenerate the Prisma client

**Files:** none (generates into `node_modules/.prisma`).

Steps:

- [ ] **Step 1:** Validate the schema parses and the relations resolve (catches a malformed `@relation` or duplicate `@@map` before generating):
   ```bash
   cd /Users/tabish/Desktop/dashmani-platform && npx prisma validate --schema packages/db/prisma/schema.prisma
   ```
   Expected output:
   ```
   The schema at packages/db/prisma/schema.prisma is valid 🚀
   ```

- [ ] **Step 2:** Regenerate the Prisma client so the new model types (`Entity`, `LinkContent`, `LinkContentEntity`) are available across the monorepo (required after any schema change — CLAUDE.md):
   ```bash
   cd /Users/tabish/Desktop/dashmani-platform && npm run db:generate
   ```
   Expected output contains:
   ```
   ✔ Generated Prisma Client
   ```

- [ ] **Step 3:** Prove the client now exposes the three new delegates (compile-time check that generation succeeded — no DB needed):
   ```bash
   cd /Users/tabish/Desktop/dashmani-platform && npx tsx -e "import { PrismaClient } from '@prisma/client'; const p = new PrismaClient(); console.log(['entity','linkContent','linkContentEntity'].map(k => k + ':' + (k in p)).join(' '));"
   ```
   Expected output:
   ```
   entity:true linkContent:true linkContentEntity:true
   ```

### Task 3: Prove the db:push diff is purely additive, then push locally

**Files:** none (mutates the **local** dev DB only).

Steps:

- [ ] **Step 1:** Confirm Docker Postgres is up (db:push needs a live DB; CLAUDE.md `docker-compose up -d`):
   ```bash
   cd /Users/tabish/Desktop/dashmani-platform && docker ps --format '{{.Names}}\t{{.Status}}' | grep -i postgres
   ```
   Expected: a postgres container line showing `(healthy)`. If absent, run `docker-compose up -d` first.

- [ ] **Step 2:** **Prove the diff is additive (the CLAUDE.md "always diff before db:push — it silently DROPs columns the new schema doesn't define" rule).** Print the migration SQL Prisma *would* apply without touching the DB:
   ```bash
   cd /Users/tabish/Desktop/dashmani-platform && npx prisma migrate diff \
     --from-schema-datasource packages/db/prisma/schema.prisma \
     --to-schema-datamodel packages/db/prisma/schema.prisma \
     --script
   ```
   This first command (datasource→datamodel against the same schema) describes the delta between the **live local DB** and the new schema. Expected: only `CREATE TABLE "entities"`, `CREATE TABLE "link_content"`, `CREATE TABLE "link_content_entities"`, their `CREATE UNIQUE INDEX`/`CREATE INDEX` lines, and the two `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` lines for the `link_content_entities` self-contained FKs.

- [ ] **Step 3:** **Hard gate — assert there is nothing to drop.** Grep the diff for any destructive statement; the feature is additive-only so this must come back empty:
   ```bash
   cd /Users/tabish/Desktop/dashmani-platform && npx prisma migrate diff \
     --from-schema-datasource packages/db/prisma/schema.prisma \
     --to-schema-datamodel packages/db/prisma/schema.prisma \
     --script | grep -iE 'DROP (TABLE|COLUMN)|ALTER TABLE "(report_links|link_metrics|users|report_drafts|social_accounts|daily_reports)"' || echo "ADDITIVE-ONLY: no drops, no edits to existing tables"
   ```
   Expected output:
   ```
   ADDITIVE-ONLY: no drops, no edits to existing tables
   ```
   If this prints *any* `DROP …` or an `ALTER TABLE` against an existing table, **STOP** — the append touched an existing model; revert Task 1 and re-diff before proceeding. (The only `ALTER TABLE` lines allowed are `ADD CONSTRAINT … FOREIGN KEY` on the brand-new `link_content_entities` table, which this grep deliberately does not match.)

- [ ] **Step 4:** Push the additive schema to the local dev DB:
   ```bash
   cd /Users/tabish/Desktop/dashmani-platform && npm run db:push
   ```
   Expected output contains:
   ```
   🚀  Your database is now in sync with your Prisma schema.
   ```

- [ ] **Step 5:** Verify the three tables now exist in the local DB with their expected columns (proves the push landed, not just claimed success):
   ```bash
   cd /Users/tabish/Desktop/dashmani-platform && docker exec -i $(docker ps -qf "ancestor=postgres:16" | head -1) psql -U user -d dashmani -c "\dt entities|link_content|link_content_entities" -c "\d link_content"
   ```
   Expected: all three tables listed under `public`, and `\d link_content` shows columns `id, canonical_key, platform, title, caption, status, extracted_at, fetched_at, created_at, updated_at` plus the unique index on `canonical_key` and indexes on `status` / `extracted_at`. (If the `ancestor` filter returns nothing, substitute the postgres container name from Task 3 step 1.)

### Task 4: Commit the schema addition

**Files:** none new (commits `packages/db/prisma/schema.prisma`).

Steps:

- [ ] **Step 1:** Stage only the schema file (the generated client lives in `node_modules` and is gitignored — nothing else changed):
   ```bash
   cd /Users/tabish/Desktop/dashmani-platform && git add packages/db/prisma/schema.prisma && git status --short
   ```
   Expected output:
   ```
   M  packages/db/prisma/schema.prisma
   ```

- [ ] **Step 2:** Commit with a conventional message that records the additive-only nature and the **manual prod `db:push`** note (CI never runs `db:push`; this must happen on Linode after deploy with the same additive-diff check — CLAUDE.md):
   ```bash
   cd /Users/tabish/Desktop/dashmani-platform && git commit -m "$(cat <<'EOF'
   feat(db): add Entity / LinkContent / LinkContentEntity tables for link-entity-search (additive)

   Three new tables for the link entity search pipeline (spec
   docs/superpowers/specs/2026-06-22-link-entity-search-design.md §4).
   Purely additive: CREATE TABLE only, zero changes to existing models —
   verified via `prisma migrate diff` (no DROP, no ALTER on existing tables).
   LinkContent has no FK to ReportLink (join by canonicalKey on read), so it
   survives the report_links delete-and-recreate churn.

   ⚠️ db:push is MANUAL on Linode AFTER deploy (CI never runs it). Before
   running it on prod, re-run the additive-diff check from Phase A Task 3 to
   confirm only CREATE TABLE statements apply.

   Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
   EOF
   )"
   ```
   Expected: one commit created touching exactly one file (`1 file changed`).

## Phase B — Stage 1 Enrich (fetch caption/title, YouTube-first)

This phase extends the existing `social-insights` pipeline to fetch each post's title/caption alongside its metrics, upserts that text into the new `LinkContent` table (keyed by `canonicalKey`, classified by URL prefix), and provides a dry-run backfill. **The existing metric-snapshot write path stays byte-identical** — content writes are purely additive and independently `try/catch`-guarded.

> Assumes Phase A has already added `model Entity`, `model LinkContent`, `model LinkContentEntity` to `packages/db/prisma/schema.prisma` and run `db:generate`, so `prisma.linkContent` is available on the client. If `prisma.linkContent` is not yet on the type, run `npm run db:generate` from the repo root before starting the TDD steps below.

---

### Task 5: Extend `InsightFetchResult` with optional `title` / `caption` (backward-compatible)

Adding two **optional** fields means every existing provider and the cron keep compiling and behaving identically — no existing field changes.

**Files:**
- Modify: `apps/api/src/services/social-insights/types.ts` (lines 1–9, the `InsightFetchResult` interface)

**Steps:**

- [ ] **Step 1:** Edit `apps/api/src/services/social-insights/types.ts`. Replace the `InsightFetchResult` interface (lines 1–9) with:

   ```ts
   export interface InsightFetchResult {
     ok: boolean;
     status: "ok" | "not_found" | "private" | "rate_limited" | "error";
     views?: number | null;
     likes?: number | null;
     comments?: number | null;
     shares?: number | null;
     /** Post title (YouTube `snippet.title`). Optional → existing providers/consumers unaffected. */
     title?: string | null;
     /** Post caption/body (YouTube `snippet.description`; IG/FB `caption` when those providers land). */
     caption?: string | null;
     error?: string;
   }
   ```

- [ ] **Step 2:** Verify the type compiles and nothing else broke:

   ```bash
   npx tsc --noEmit -p apps/api/tsconfig.json
   ```

   Expected: no output (exit 0). The two new optional fields can't break `youtube.provider.ts`, `instagram.provider.ts`, `facebook.provider.ts`, or `social-insights.cron.ts` because they were never required.

- [ ] **Step 3:** Commit:

   ```bash
   git add apps/api/src/services/social-insights/types.ts
   git commit -m "$(cat <<'EOF'
   feat(insights): add optional title/caption to InsightFetchResult

   Backward-compatible — existing providers and the cron compile and behave
   identically. Enables Stage 1 enrich to carry post text alongside metrics.

   Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
   EOF
   )"
   ```

---

### Task 2 (TDD): YouTube provider returns `title`/`caption` from `snippet` — metrics byte-identical

Switch the existing batched call from `part=statistics` to `part=statistics,snippet` (a superset of the same request — `snippet.title`+`snippet.description` come back in the same call) and map them into the new optional fields. The metrics mapping (`views`/`likes`/`comments`/`shares`) must be **unchanged**. We prove this with a test that asserts both the new fields are populated AND the metrics still match the statistics block exactly.

**Files:**
- Create: `apps/api/tests/youtube-provider.test.ts`
- Modify: `apps/api/src/services/social-insights/youtube.provider.ts` (interfaces lines 7–21; fetch URL line 58; result mapping lines 102–111)

**Steps:**

- [ ] **Step 1:** Write the failing test. Create `apps/api/tests/youtube-provider.test.ts`. This test does NOT touch the DB (it stubs `global.fetch`), so it does not import `./setup` and needs no truncation:

   ```ts
   import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
   import { youTubeProvider } from "../src/services/social-insights/youtube.provider";
   import type { InsightTarget } from "../src/services/social-insights/types";

   const target = (videoId: string): InsightTarget => ({
     linkId: `link-${videoId}`,
     url: `https://youtu.be/${videoId}`,
     urlNormalized: `https://youtu.be/${videoId}`,
     targetId: videoId,
     employeeId: "emp-1",
     reportDate: new Date("2026-06-20T00:00:00.000Z"),
   });

   describe("youTubeProvider.fetchBatch — snippet enrichment", () => {
     const ORIGINAL_KEY = process.env.YOUTUBE_API_KEY;

     beforeEach(() => {
       process.env.YOUTUBE_API_KEY = "test-key";
     });

     afterEach(() => {
       process.env.YOUTUBE_API_KEY = ORIGINAL_KEY;
       vi.restoreAllMocks();
     });

     it("requests part=statistics,snippet", async () => {
       const fetchMock = vi.fn(async () => ({
         ok: true,
         json: async () => ({ items: [] }),
       })) as unknown as typeof fetch;
       vi.stubGlobal("fetch", fetchMock);

       await youTubeProvider.fetchBatch([target("dQw4w9WgXcQ")]);

       const calledUrl = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as string;
       expect(calledUrl).toContain("part=statistics%2Csnippet");
     });

     it("maps snippet.title→title, snippet.description→caption AND keeps metrics identical", async () => {
       vi.stubGlobal(
         "fetch",
         vi.fn(async () => ({
           ok: true,
           json: async () => ({
             items: [
               {
                 id: "dQw4w9WgXcQ",
                 statistics: { viewCount: "1234", likeCount: "56", commentCount: "7" },
                 snippet: {
                   title: "Never Gonna Give You Up",
                   description: "Official music video. #rickroll",
                 },
               },
             ],
           }),
         })) as unknown as typeof fetch,
       );

       const out = await youTubeProvider.fetchBatch([target("dQw4w9WgXcQ")]);
       const r = out.get("link-dQw4w9WgXcQ");

       // New fields populated:
       expect(r?.title).toBe("Never Gonna Give You Up");
       expect(r?.caption).toBe("Official music video. #rickroll");
       // Metrics mapping unchanged (byte-identical to pre-snippet behavior):
       expect(r?.ok).toBe(true);
       expect(r?.status).toBe("ok");
       expect(r?.views).toBe(1234);
       expect(r?.likes).toBe(56);
       expect(r?.comments).toBe(7);
       expect(r?.shares).toBe(null);
     });

     it("leaves title/caption null when snippet is absent (metrics still mapped)", async () => {
       vi.stubGlobal(
         "fetch",
         vi.fn(async () => ({
           ok: true,
           json: async () => ({
             items: [{ id: "dQw4w9WgXcQ", statistics: { viewCount: "9", likeCount: "1", commentCount: "0" } }],
           }),
         })) as unknown as typeof fetch,
       );

       const out = await youTubeProvider.fetchBatch([target("dQw4w9WgXcQ")]);
       const r = out.get("link-dQw4w9WgXcQ");
       expect(r?.views).toBe(9);
       expect(r?.title).toBe(null);
       expect(r?.caption).toBe(null);
     });
   });
   ```

- [ ] **Step 2:** Run it and watch it fail (current provider neither requests `snippet` nor maps title/caption):

   ```bash
   npm run test -w @dashmani/api -- youtube-provider
   ```

   Expected: FAIL — the `part=` assertion fails (`expected "part=statistics&..." to contain "part=statistics%2Csnippet"`) and `r?.title` is `undefined`, not `"Never Gonna Give You Up"`.

- [ ] **Step 3:** Make it pass with the minimal provider change. In `apps/api/src/services/social-insights/youtube.provider.ts`, add `snippet` to the response interfaces. Replace lines 13–16:

   ```ts
   interface YouTubeSnippet {
     title?: string;
     description?: string;
   }

   interface YouTubeItem {
     id: string;
     statistics?: YouTubeStatistics;
     snippet?: YouTubeSnippet;
   }
   ```

- [ ] **Step 4:** Change the fetch URL (line 58) from `part=statistics` to `part=statistics,snippet`:

   ```ts
         const res = await fetch(
           `https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${encodeURIComponent(videoIds)}&key=${apiKey}`,
           { signal: controller.signal }
         );
   ```

- [ ] **Step 5:** Carry the snippet through the response map. Replace lines 92–95 (the `statsById` build) with a single combined map so we don't drop snippet:

   ```ts
       // Build a map of videoId → { statistics, snippet } from the response
       const itemsById = new Map<string, YouTubeItem>();
       for (const item of data.items ?? []) {
         itemsById.set(item.id, item);
       }
   ```

- [ ] **Step 6:** Update the per-target mapping. Replace lines 97–112 (the `for (const t of batch)` block that reads `statsById`) with:

   ```ts
       for (const t of batch) {
         const item = itemsById.get(t.targetId);
         if (!item) {
           // Video not in response — deleted, private, or unlisted
           results.set(t.linkId, { ok: false, status: "not_found" });
         } else {
           const stats = item.statistics ?? {};
           results.set(t.linkId, {
             ok: true,
             status: "ok",
             views: stats.viewCount != null ? parseInt(stats.viewCount, 10) : null,
             likes: stats.likeCount != null ? parseInt(stats.likeCount, 10) : null,
             comments: stats.commentCount != null ? parseInt(stats.commentCount, 10) : null,
             shares: null, // YouTube Data API does not provide share counts
             title: item.snippet?.title ?? null,
             caption: item.snippet?.description ?? null,
           });
         }
       }
   ```

   The `views`/`likes`/`comments`/`shares` expressions are **copied verbatim** from the original — only `title`/`caption` are added. The `not_found` branch is unchanged.

- [ ] **Step 7:** Run the test again — it must pass:

   ```bash
   npm run test -w @dashmani/api -- youtube-provider
   ```

   Expected: PASS (3 passed).

- [ ] **Step 8:** Type-check the API:

   ```bash
   npx tsc --noEmit -p apps/api/tsconfig.json
   ```

   Expected: no output (exit 0).

- [ ] **Step 9:** Commit:

   ```bash
   git add apps/api/src/services/social-insights/youtube.provider.ts apps/api/tests/youtube-provider.test.ts
   git commit -m "$(cat <<'EOF'
   feat(insights): YouTube provider fetches snippet title/description

   part=statistics → part=statistics,snippet (superset of the same batched
   call, no extra quota beyond a trivial per-part unit). Maps snippet.title→
   title, snippet.description→caption. Metrics mapping (views/likes/comments/
   shares) is byte-identical — test asserts both the new fields populate AND
   the metrics are unchanged.

   Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
   EOF
   )"
   ```

---

### Task 3 (TDD): `link-content.service.ts` — `upsertLinkContent` keyed by `canonicalKey`

The service upserts post text into `LinkContent` by its unique `canonicalKey`. Idempotent: the same key twice yields one row and updates the text. `status` becomes `"ok"` when any title/caption text is present, otherwise stays/falls back to `"not_found"`. **Platform is classified by the `canonicalKey` prefix** (`yt:`/`ig:`/`fb:`), never the dirty `report_links.platform` column.

**Files:**
- Create: `apps/api/src/services/link-content.service.ts`
- Create: `apps/api/tests/link-content.test.ts`

**Steps:**

- [ ] **Step 1:** Write the failing test. Create `apps/api/tests/link-content.test.ts`. Because `setup.ts` does NOT truncate the new tables, this test cleans `link_content` itself in `beforeEach`/`afterAll`:

   ```ts
   import { describe, it, expect, beforeEach, afterAll } from "vitest";
   import { prisma } from "@dashmani/db";
   import { upsertLinkContent, platformFromCanonicalKey } from "../src/services/link-content.service";

   beforeEach(async () => {
     await prisma.$executeRawUnsafe(`TRUNCATE TABLE link_content_entities, link_content, entities CASCADE`);
   });

   afterAll(async () => {
     await prisma.$executeRawUnsafe(`TRUNCATE TABLE link_content_entities, link_content, entities CASCADE`);
     await prisma.$disconnect();
   });

   describe("platformFromCanonicalKey", () => {
     it("classifies by canonicalKey prefix, not the dirty platform column", () => {
       expect(platformFromCanonicalKey("yt:dQw4w9WgXcQ")).toBe("youtube");
       expect(platformFromCanonicalKey("ig:DZJyjhBKN5-")).toBe("instagram");
       expect(platformFromCanonicalKey("fb:123456789")).toBe("facebook");
       expect(platformFromCanonicalKey("https://snapchat.com/whatever")).toBe("other");
     });
   });

   describe("upsertLinkContent", () => {
     it("creates one row with status=ok when text is present", async () => {
       const row = await upsertLinkContent({
         canonicalKey: "yt:dQw4w9WgXcQ",
         title: "Never Gonna Give You Up",
         caption: "Official video",
       });

       expect(row.canonicalKey).toBe("yt:dQw4w9WgXcQ");
       expect(row.platform).toBe("youtube");
       expect(row.title).toBe("Never Gonna Give You Up");
       expect(row.caption).toBe("Official video");
       expect(row.status).toBe("ok");
       expect(row.fetchedAt).not.toBeNull();
       expect(row.extractedAt).toBeNull(); // stage 2 stamps this, not stage 1
     });

     it("is idempotent on canonicalKey — second call updates, does not duplicate", async () => {
       await upsertLinkContent({ canonicalKey: "yt:abc", title: "v1", caption: null });
       await upsertLinkContent({ canonicalKey: "yt:abc", title: "v2 updated", caption: "now has caption" });

       const all = await prisma.linkContent.findMany({ where: { canonicalKey: "yt:abc" } });
       expect(all).toHaveLength(1);
       expect(all[0].title).toBe("v2 updated");
       expect(all[0].caption).toBe("now has caption");
       expect(all[0].status).toBe("ok");
     });

     it("uses status=not_found when there is no title and no caption", async () => {
       const row = await upsertLinkContent({ canonicalKey: "yt:empty", title: null, caption: null });
       expect(row.status).toBe("not_found");
       expect(row.fetchedAt).not.toBeNull();
     });

     it("respects an explicit status override (e.g. private/error from the provider)", async () => {
       const row = await upsertLinkContent({ canonicalKey: "yt:priv", title: null, caption: null, status: "private" });
       expect(row.status).toBe("private");
     });

     it("never re-classifies an existing row's platform on update", async () => {
       const a = await upsertLinkContent({ canonicalKey: "ig:CODE1", title: "a", caption: null });
       const b = await upsertLinkContent({ canonicalKey: "ig:CODE1", title: "b", caption: null });
       expect(a.platform).toBe("instagram");
       expect(b.platform).toBe("instagram");
     });
   });
   ```

- [ ] **Step 2:** Run it — it fails because the service file does not exist yet:

   ```bash
   npm run test -w @dashmani/api -- link-content
   ```

   Expected: FAIL — `Cannot find module '../src/services/link-content.service'`.

- [ ] **Step 3:** Create the service. Write `apps/api/src/services/link-content.service.ts`:

   ```ts
   import { prisma } from "@dashmani/db";
   import type { LinkContent } from "@prisma/client";

   /**
    * Classify a post's platform from its canonicalKey PREFIX, never the dirty
    * report_links.platform column (which has mixed casing and client-sent junk —
    * see CLAUDE.md "Reports bug batch" on platform-column casing). The prefix is
    * produced by canonicalKey() in @dashmani/shared: ig: / yt: / fb:.
    */
   export function platformFromCanonicalKey(canonicalKey: string): string {
     if (canonicalKey.startsWith("yt:")) return "youtube";
     if (canonicalKey.startsWith("ig:")) return "instagram";
     if (canonicalKey.startsWith("fb:")) return "facebook";
     return "other"; // full-URL fallback (Snapchat, opaque FB /share/, unrecognized)
   }

   export interface UpsertLinkContentInput {
     canonicalKey: string;
     title?: string | null;
     caption?: string | null;
     /** Optional override (e.g. "private" / "error" from the provider). Defaults to ok|not_found based on text. */
     status?: string;
   }

   /**
    * Upsert one LinkContent row keyed on its unique canonicalKey. Idempotent:
    * the same key always maps to exactly one row; subsequent calls refresh the
    * text + fetchedAt. extractedAt is left untouched here — Stage 2 owns it.
    */
   export async function upsertLinkContent(input: UpsertLinkContentInput): Promise<LinkContent> {
     const { canonicalKey } = input;
     const title = input.title ?? null;
     const caption = input.caption ?? null;
     const platform = platformFromCanonicalKey(canonicalKey);
     const hasText = (title != null && title.trim() !== "") || (caption != null && caption.trim() !== "");
     const status = input.status ?? (hasText ? "ok" : "not_found");
     const fetchedAt = new Date();

     return prisma.linkContent.upsert({
       where: { canonicalKey },
       create: { canonicalKey, platform, title, caption, status, fetchedAt },
       update: { title, caption, status, fetchedAt },
     });
   }
   ```

- [ ] **Step 4:** Run the test again — it must pass:

   ```bash
   npm run test -w @dashmani/api -- link-content
   ```

   Expected: PASS (6 passed). If it fails with `prisma.linkContent` undefined, run `npm run db:generate` from the repo root (Phase A added the model) and re-run.

- [ ] **Step 5:** Type-check:

   ```bash
   npx tsc --noEmit -p apps/api/tsconfig.json
   ```

   Expected: no output (exit 0).

- [ ] **Step 6:** Commit:

   ```bash
   git add apps/api/src/services/link-content.service.ts apps/api/tests/link-content.test.ts
   git commit -m "$(cat <<'EOF'
   feat(insights): link-content.service upsert keyed on canonicalKey

   upsertLinkContent is idempotent on canonicalKey (one row per unique post,
   updates text on resubmit). platformFromCanonicalKey classifies by the
   ig:/yt:/fb: prefix, NOT the dirty report_links.platform column. status is
   ok when text is present, not_found otherwise, or an explicit override.
   Tests clean link_content themselves (setup.ts does not truncate it).

   Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
   EOF
   )"
   ```

---

### Task 6: Wire content upsert into the existing cron as an additive, isolated write

Add the content write **inside the existing snapshot loop**, immediately after the metric `linkMetric.create` succeeds, wrapped in its own `try/catch` so a content failure can never affect the metric write or the run. Compute `canonicalKey` via the imported shared helper (never reimplement). Verification-based (no new unit test): we prove the metric path is structurally untouched by re-running the existing insights tests + the type-check, then a manual smoke of the cron.

**Files:**
- Modify: `apps/api/src/cron/social-insights.cron.ts` (import block lines 1–5; the per-target write block lines 106–137)

**Steps:**

- [ ] **Step 1:** Add the two imports the content write needs. In `apps/api/src/cron/social-insights.cron.ts`, change the import block (lines 1–5) to:

   ```ts
   import { prisma } from "@dashmani/db";
   import { extractYouTubeVideoId, canonicalKey } from "@dashmani/shared";
   import { getSupportedSlugs, getProvider } from "../services/social-insights";
   import type { InsightTarget } from "../services/social-insights";
   import { youTubeQuotaExceeded } from "../services/social-insights/youtube.provider";
   import { upsertLinkContent } from "../services/link-content.service";
   ```

- [ ] **Step 2:** Insert the content write **after** the metric create's success accounting and **before** the inner `catch (writeErr)`. The metric `prisma.linkMetric.create({...})` call (lines 112–128) and its `if (r.status === "ok") succeeded++ …` block (lines 130–132) stay byte-identical. Locate the success accounting (currently lines 130–132):

   ```ts
               if (r.status === "ok") succeeded++;
               else if (r.status === "not_found") notFound++;
               else errors++;
   ```

   Immediately **after** those three lines (still inside the inner `try`, before `} catch (writeErr) {`), add:

   ```ts
               // ── Stage 1 ENRICH (additive, isolated) ───────────────────────
               // Write the post's title/caption into LinkContent alongside the
               // metric snapshot. Keyed on canonicalKey so each unique post is
               // upserted once regardless of how many ReportLinks point at it.
               // Its own try/catch: a content failure NEVER fails a metric write
               // or the run — it logs and continues. The metric path above is
               // unchanged.
               if (r.status === "ok" && (r.title != null || r.caption != null)) {
                 try {
                   await upsertLinkContent({
                     canonicalKey: canonicalKey(t.url),
                     title: r.title ?? null,
                     caption: r.caption ?? null,
                   });
                 } catch (contentErr) {
                   console.error(
                     `[social-insights/${slug}] content upsert failed for linkId ${t.linkId} (metric write unaffected):`,
                     contentErr,
                   );
                 }
               }
   ```

- [ ] **Step 3:** Confirm the existing insights behavior is structurally intact — run the provider test from Task 2 and any existing insights/daily-report tests, plus type-check:

   ```bash
   npm run test -w @dashmani/api -- youtube-provider link-content daily-report
   npx tsc --noEmit -p apps/api/tsconfig.json
   ```

   Expected: provider/link-content/daily-report suites PASS; `tsc` exits 0. (Pre-existing analytics/content/task/team failures are out of scope per the brief — do not run those.)

- [ ] **Step 4:** Manual smoke of the wired cron against the local DB (proves the content write fires without breaking metric snapshots). With Postgres up (`docker-compose up -d`) and `YOUTUBE_API_KEY` + a YouTube link present in a recent daily report, run a one-shot invocation:

   ```bash
   cd packages/db && npx tsx -e "import('../../apps/api/src/cron/social-insights.cron').then(m => m.runSocialInsightsRefresh()).then(() => process.exit(0))"
   ```

   Expected log lines: `[social-insights] starting …`, `[social-insights/youtube] N links → …`, `[social-insights] done in …ms` with **no** `content upsert failed` errors. Then confirm rows landed (metrics AND content):

   ```bash
   cd packages/db && npx tsx -e "import('@dashmani/db').then(async ({prisma}) => { console.log('link_metrics:', await prisma.linkMetric.count()); console.log('link_content:', await prisma.linkContent.count({where:{status:'ok'}})); await prisma.\$disconnect(); })"
   ```

   Expected: both counts > 0 (content count ≤ metric count, since content dedupes by canonicalKey). If there are no local YouTube links, this step is a no-op (`0 links to poll`) — that's still a valid pass for the wiring (no crash); rely on Task 5's dry-run for content population.

- [ ] **Step 5:** Commit:

   ```bash
   git add apps/api/src/cron/social-insights.cron.ts
   git commit -m "$(cat <<'EOF'
   feat(insights): cron writes LinkContent alongside metric snapshots

   Additive, isolated content upsert inside the existing snapshot loop,
   immediately after a successful metric write, guarded by its own try/catch
   so a content failure can never fail a metric snapshot or the run. Keyed on
   canonicalKey() from @dashmani/shared (imported, not reimplemented). The
   metric-writing path is byte-identical.

   Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
   EOF
   )"
   ```

---

### Task 7: `scripts/enrich-link-content.ts` — dry-run backfill over distinct YouTube `canonicalKey`s

A one-time backfill that walks distinct `canonicalKey`s for supported platforms (YouTube ≈ 431), fetches each via the existing provider, and upserts `LinkContent`. Dry-run by default; `--apply` (+ `--confirm-prod` for prod writes) to write. Verification-based (the underlying `upsertLinkContent` + provider already have unit tests; this script is an orchestrator over them).

**Files:**
- Create: `scripts/enrich-link-content.ts`

**Steps:**

- [ ] **Step 1:** Create `scripts/enrich-link-content.ts`. It imports the real `@dashmani/shared` helpers and the real provider/service so behavior stays in lockstep with the cron (no inlined copies for this one — it's a dev/prod backfill run from `packages/db`, where the workspace deps resolve):

   ```ts
   /**
    * Stage 1 ENRICH backfill — fetch title/caption for every UNIQUE post and
    * upsert it into LinkContent. Walks distinct canonicalKey()s of report_links
    * whose platform is insight-supported (today: YouTube only, ~431 links →
    * far fewer unique posts). Each unique post is fetched ONCE.
    *
    * Reuses the SAME provider + service the 6h cron uses, so it can never drift
    * from production enrichment behavior. The existing metrics pipeline is not
    * touched — this writes only the additive link_content table.
    *
    * Dry-run by default. Writes require --apply (and --confirm-prod on prod).
    * Always back up first on prod:
    *   ssh linode "pg_dump dashmani_prod > /tmp/backup_$(date +%Y%m%d_%H%M%S).sql"
    *
    * Usage:
    *   cd /opt/dashmani-platform/packages/db && npx tsx ../../scripts/enrich-link-content.ts
    *   cd /opt/dashmani-platform/packages/db && npx tsx ../../scripts/enrich-link-content.ts --apply --confirm-prod
    *   # optional: cap how many unique posts to process this run
    *   ... enrich-link-content.ts --limit 100
    */

   import { prisma } from "@dashmani/db";
   import { canonicalKey, getSupportedInsightPlatforms } from "@dashmani/shared";
   import { getProvider } from "../apps/api/src/services/social-insights";
   import type { InsightTarget } from "../apps/api/src/services/social-insights";
   import { upsertLinkContent, platformFromCanonicalKey } from "../apps/api/src/services/link-content.service";

   const args = process.argv.slice(2);
   const APPLY = args.includes("--apply");
   const CONFIRM_PROD = args.includes("--confirm-prod");
   const DRY_RUN = !APPLY;
   const limitIdx = args.indexOf("--limit");
   const LIMIT = limitIdx >= 0 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : Infinity;

   if (APPLY && !CONFIRM_PROD) {
     console.error("\n[ERROR] --apply requires --confirm-prod to prevent accidental production writes.\n");
     process.exit(1);
   }
   const mode = DRY_RUN ? "[DRY-RUN]" : "[APPLY]  ";

   async function main() {
     const supported = getSupportedInsightPlatforms(); // ["youtube"]
     console.log(`${mode} enrich-link-content — supported platforms: ${supported.join(", ")}`);

     for (const slug of supported) {
       const provider = getProvider(slug);
       if (!provider || !provider.isSupported()) {
         console.log(`${mode} provider "${slug}" not configured (missing API key?) — skipping`);
         continue;
       }

       // 1. Pull all candidate links for this platform; collapse to UNIQUE posts by canonicalKey.
       const rows = await prisma.reportLink.findMany({
         where: { platform: { equals: slug, mode: "insensitive" }, url: { not: null }, isScheduled: false },
         select: { id: true, url: true },
       });

       // canonicalKey → first representative target (one fetch per unique post)
       const uniqueByKey = new Map<string, InsightTarget>();
       for (const row of rows) {
         if (!row.url) continue;
         const url = row.url.trim();
         const key = canonicalKey(url);
         if (platformFromCanonicalKey(key) !== slug) continue; // only keys this provider owns
         if (uniqueByKey.has(key)) continue;
         const targetId = provider.extractTargetId(url);
         if (!targetId) continue;
         uniqueByKey.set(key, {
           linkId: key, // we key the result by canonicalKey for this backfill
           url,
           urlNormalized: url.toLowerCase(),
           targetId,
           employeeId: "",
           reportDate: new Date(),
         });
       }

       const allTargets = Array.from(uniqueByKey.values()).slice(0, LIMIT === Infinity ? undefined : LIMIT);
       console.log(`${mode} [${slug}] ${rows.length} links → ${uniqueByKey.size} unique posts → processing ${allTargets.length}`);

       if (DRY_RUN) {
         console.log(`${mode} [${slug}] would fetch + upsert ${allTargets.length} unique posts. Sample keys:`);
         for (const t of allTargets.slice(0, 5)) console.log(`           ${t.linkId}`);
         continue;
       }

       // 2. APPLY: fetch in the provider's natural batches, upsert each.
       let ok = 0;
       let notFound = 0;
       let failed = 0;
       const BATCH = 50;
       for (let i = 0; i < allTargets.length; i += BATCH) {
         const batch = allTargets.slice(i, i + BATCH);
         const results = await provider.fetchBatch(batch);
         for (const t of batch) {
           const r = results.get(t.linkId);
           try {
             await upsertLinkContent({
               canonicalKey: t.linkId, // = canonicalKey
               title: r?.title ?? null,
               caption: r?.caption ?? null,
               status: r?.status === "ok" ? undefined : (r?.status ?? "error"),
             });
             if (r?.status === "ok") ok++;
             else if (r?.status === "not_found") notFound++;
             else failed++;
           } catch (err) {
             failed++;
             console.error(`[APPLY] [${slug}] upsert failed for ${t.linkId}:`, err);
           }
         }
         console.log(`${mode} [${slug}] processed ${Math.min(i + BATCH, allTargets.length)}/${allTargets.length}`);
       }
       console.log(`${mode} [${slug}] done — ${ok} ok, ${notFound} not_found, ${failed} failed`);
     }
   }

   main()
     .then(() => prisma.$disconnect())
     .catch(async (err) => {
       console.error(err);
       await prisma.$disconnect();
       process.exit(1);
     });
   ```

- [ ] **Step 2:** Type-check the script under the API tsconfig (it imports API service files). Verify it compiles:

   ```bash
   npx tsc --noEmit scripts/enrich-link-content.ts --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --noEmit
   ```

   Expected: no errors. (If a path-resolution warning appears under this ad-hoc invocation, the authoritative check is the dry-run in step 3 actually running under `tsx`.)

- [ ] **Step 3:** Run the dry-run against the local DB (proves it walks links, collapses to unique posts, and writes nothing):

   ```bash
   cd packages/db && npx tsx ../../scripts/enrich-link-content.ts
   ```

   Expected output shape:
   ```
   [DRY-RUN] enrich-link-content — supported platforms: youtube
   [DRY-RUN] [youtube] <N> links → <M> unique posts → processing <M>
   [DRY-RUN] [youtube] would fetch + upsert <M> unique posts. Sample keys:
              yt:dQw4w9WgXcQ
              ...
   ```
   It must write **zero** rows. Confirm:
   ```bash
   cd packages/db && npx tsx -e "import('@dashmani/db').then(async ({prisma}) => { console.log('link_content rows:', await prisma.linkContent.count()); await prisma.\$disconnect(); })"
   ```
   Expected: unchanged from before the dry-run (no new rows).

- [ ] **Step 4:** (Optional local apply smoke — only if local DB has YouTube links and `YOUTUBE_API_KEY` is set) Verify a real apply populates content:

   ```bash
   cd packages/db && npx tsx ../../scripts/enrich-link-content.ts --apply --confirm-prod --limit 5
   ```

   Expected: `[APPLY]  [youtube] done — X ok, Y not_found, Z failed` and `link_content` count increases by up to 5.

- [ ] **Step 5:** Commit:

   ```bash
   git add scripts/enrich-link-content.ts
   git commit -m "$(cat <<'EOF'
   feat(insights): enrich-link-content backfill script (dry-run default)

   Walks distinct canonicalKey()s of insight-supported platforms (YouTube
   only today, ~431 links → far fewer unique posts), fetches title/caption
   via the SAME provider + upsertLinkContent the 6h cron uses, so the backfill
   can never drift from production behavior. Dry-run by default; --apply
   requires --confirm-prod. Writes only the additive link_content table; the
   metrics pipeline is untouched.

   Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
   EOF
   )"
   ```

---

### Task 8: Phase B verification gate (tsc + targeted tests + safety re-check)

A single gate that proves Phase B is green and the existing metrics path is structurally unchanged before handing off to Phase C. No new code.

**Files:** none (verification only).

**Steps:**

- [ ] **Step 1:** Type-check api + shared (the two workspaces Phase B touched):

   ```bash
   npx tsc --noEmit -p apps/api/tsconfig.json
   npx tsc --noEmit -p packages/shared/tsconfig.json
   ```

   Expected: both exit 0 with no output.

- [ ] **Step 2:** Run only the suites this phase added/affects (avoids the ~36 pre-existing analytics/content/task/team failures called out in the brief):

   ```bash
   npm run test -w @dashmani/api -- youtube-provider link-content daily-report canonical-url
   ```

   Expected: all four suites PASS. `youtube-provider` (3), `link-content` (6), plus the existing `daily-report` and `canonical-url` suites still green (the cron change and shared import did not regress them).

- [ ] **Step 3:** Confirm the metrics-write code is byte-identical to `main` (the safety guarantee). Diff just the metric-create region:

   ```bash
   git diff origin/main -- apps/api/src/cron/social-insights.cron.ts
   ```

   Expected: the only additions are the two new imports and the `// ── Stage 1 ENRICH …` block; the `prisma.linkMetric.create({...})` call, its `succeeded/notFound/errors` accounting, the quota handling, and the re-heal raw SQL are unchanged. If any line inside `linkMetric.create({...})` shows as changed, revert that line — the metric path must not move.

- [ ] **Step 4:** Confirm `SUPPORTED_INSIGHT_PLATFORMS` is still `["youtube"]` (IG/FB stay dark):

   ```bash
   grep -n "SUPPORTED_INSIGHT_PLATFORMS" packages/shared/src/utils/social-insights.ts
   ```

   Expected: `export const SUPPORTED_INSIGHT_PLATFORMS = ["youtube"] as const;` — unchanged. Phase B must not alter this switch.

- [ ] **Step 5:** No commit (verification only). Phase B is complete: `InsightFetchResult` carries optional text, the YouTube provider fills it from `snippet` with metrics byte-identical, `LinkContent` is upserted by `canonicalKey` from both the cron (isolated `try/catch`) and a dry-run backfill, and the existing metrics pipeline + the `["youtube"]` switch are provably untouched.

## Phase C — Stage 2 Extract (caption to canonical entities via Claude Haiku)

This phase assumes Phase A has already shipped the additive Prisma models `Entity`, `LinkContent`, `LinkContentEntity` (spec §4) and run `db:push` locally, so `prisma.entity`, `prisma.linkContent`, and `prisma.linkContentEntity` are available on the generated client. Every task below builds the LLM extraction stage on top of those tables. The existing metrics-writing path in `social-insights.cron.ts` and the YouTube provider are **not touched** by this phase.

> ⚠️ Before starting, confirm Phase A's models exist: `grep -n "model Entity\|model LinkContent\|model LinkContentEntity" packages/db/prisma/schema.prisma` must return three matches, and `npm run db:generate` must have been run. If not, Phase A is incomplete — stop and finish it first.

### Task 9: Add `entity-extraction` test scaffold and a seeded `LinkContent` fixture (failing)

The extraction service reads `status='ok' AND extractedAt IS NULL` rows from `LinkContent`. Before writing the service, write the first failing test that proves a clean caption produces an `Entity` + a `LinkContentEntity` join row. The Anthropic call is injected so the test never hits the network.

**Files:**
- Create: `apps/api/tests/entity-extraction.test.ts`

Steps:

- [ ] **Step 1:** Create `apps/api/tests/entity-extraction.test.ts` with the first test. The service (built in Task 2) will accept an injected `extractFn` so the LLM call is mockable; the test passes a fake that returns the JSON array the real Claude prompt would return:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@dashmani/db";
import {
  resolveAndPersist,
  runExtractionBatch,
  type LlmEntity,
} from "../src/services/entity-extraction.service";

// Build a fake LLM that returns a fixed JSON array for a given caption.
// Mirrors the strict-JSON contract the real Claude prompt enforces.
function fakeLlm(map: Record<string, LlmEntity[]>) {
  return async (input: { caption: string; title: string | null; knownNames: string[] }) => {
    return map[input.caption] ?? [];
  };
}

async function seedContent(args: {
  canonicalKey: string;
  caption: string;
  title?: string | null;
  status?: string;
  extractedAt?: Date | null;
}) {
  return prisma.linkContent.create({
    data: {
      canonicalKey: args.canonicalKey,
      platform: "youtube",
      title: args.title ?? null,
      caption: args.caption,
      status: args.status ?? "ok",
      extractedAt: args.extractedAt ?? null,
      fetchedAt: new Date(),
    },
  });
}

describe("entity-extraction service", () => {
  describe("resolveAndPersist — happy path", () => {
    it("creates a new Entity + join row and stamps extractedAt", async () => {
      const content = await seedContent({
        canonicalKey: "yt:dQw4w9WgXcQ",
        caption: "Exclusive interview with Salman Khan on his new film",
      });

      await resolveAndPersist(content.id, [
        { canonicalName: "Salman Khan", type: "PERSON", confidence: 0.95, isNew: true },
      ]);

      const entities = await prisma.entity.findMany();
      expect(entities).toHaveLength(1);
      expect(entities[0].canonicalName).toBe("Salman Khan");

      const joins = await prisma.linkContentEntity.findMany({ where: { linkContentId: content.id } });
      expect(joins).toHaveLength(1);
      expect(joins[0].entityId).toBe(entities[0].id);
      expect(joins[0].confidence).toBeCloseTo(0.95);

      const after = await prisma.linkContent.findUnique({ where: { id: content.id } });
      expect(after?.extractedAt).not.toBeNull();
    });
  });
});
```

- [ ] **Step 2:** Add `LinkContent`, `Entity`, and `LinkContentEntity` to the truncate list in `apps/api/tests/setup.ts` so each test starts clean. Modify the `TRUNCATE TABLE` statement — append the three new table names (their `@@map` names are `link_content_entities`, `link_content`, `entities`; list children before parents):

```ts
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE link_content_entities, link_content, entities,
      content_posts, approvals, project_files, project_tasks, project_accounts, projects,
      client_refresh_tokens, clients,
      task_comments, tasks, report_links, daily_reports, account_growth_snapshots, account_assignments, social_accounts, platforms,
      otp_tokens, audit_logs, attendance, leave_requests, refresh_tokens,
      user_roles, role_permissions, users, roles, org_units, settings
    CASCADE
  `);
```

- [ ] **Step 3:** Run the test — it MUST fail because the service file does not exist yet:

```bash
npm run test -w @dashmani/api -- entity-extraction
```

Expected: `Failed to resolve import "../src/services/entity-extraction.service"` (red). This confirms the test is wired and the module is genuinely missing.

### Task 10: Implement `entity-extraction.service.ts` — `resolveAndPersist` (make Task 1 pass)

`resolveAndPersist` upserts entities (create-new OR merge-aliases-into-existing) and join rows, then stamps `extractedAt`. It must be safe to call twice on the same content (idempotent join via the `@@unique([linkContentId, entityId])`).

**Files:**
- Create: `apps/api/src/services/entity-extraction.service.ts`

Steps:

- [ ] **Step 1:** Create `apps/api/src/services/entity-extraction.service.ts` with the types and `resolveAndPersist`. The LLM-extraction function (`extractEntitiesFromContent`) and batch runner are added in later tasks; this task only ships the persistence half plus the shared types so Task 1 compiles and passes:

```ts
import { prisma } from "@dashmani/db";

/** One entity as returned by the LLM, parsed from its strict-JSON response. */
export interface LlmEntity {
  canonicalName: string;
  type: string; // PERSON | TOPIC | BRAND | OTHER
  confidence: number;
  isNew: boolean;
}

const VALID_TYPES = new Set(["PERSON", "TOPIC", "BRAND", "OTHER"]);

function normalizeType(t: string | undefined): string {
  const up = (t ?? "").toUpperCase();
  return VALID_TYPES.has(up) ? up : "OTHER";
}

function clampConfidence(c: unknown): number {
  const n = typeof c === "number" ? c : Number(c);
  if (!Number.isFinite(n)) return 1.0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Persist the LLM's extracted entities for one LinkContent row.
 *  - Upserts each Entity by its UNIQUE canonicalName (create new, or merge any
 *    new aliases into the existing row — counts never fragment).
 *  - Upserts the LinkContentEntity join (idempotent via @@unique[linkContentId, entityId]).
 *  - Stamps LinkContent.extractedAt so the row is never re-extracted (cost control).
 * Always stamps extractedAt — even for an empty entity list — so a caption with
 * no recognizable people is marked done and never re-paid.
 */
export async function resolveAndPersist(linkContentId: string, entities: LlmEntity[]): Promise<void> {
  for (const e of entities) {
    const canonicalName = (e.canonicalName ?? "").trim();
    if (!canonicalName) continue;
    const type = normalizeType(e.type);
    const confidence = clampConfidence(e.confidence);

    // Upsert the canonical Entity. On a match, the row already exists — we leave
    // its aliases/type as-is here (alias merging from extraction is handled when
    // the LLM surfaces a NEW alias; see Task 4). create sets the canonical row.
    const entity = await prisma.entity.upsert({
      where: { canonicalName },
      update: {}, // existing canonical row is authoritative; never overwrite type/aliases on plain re-sight
      create: { canonicalName, type, aliases: [] },
    });

    // Idempotent join — re-running never creates a duplicate edge.
    await prisma.linkContentEntity.upsert({
      where: { linkContentId_entityId: { linkContentId, entityId: entity.id } },
      update: { confidence },
      create: { linkContentId, entityId: entity.id, confidence },
    });
  }

  await prisma.linkContent.update({
    where: { id: linkContentId },
    data: { extractedAt: new Date() },
  });
}
```

- [ ] **Step 2:** Run the test — Task 1's happy-path test now passes:

```bash
npm run test -w @dashmani/api -- entity-extraction
```

Expected: `1 passed` (the `resolveAndPersist — happy path` test).

- [ ] **Step 3:** Commit:

```bash
git add apps/api/src/services/entity-extraction.service.ts apps/api/tests/entity-extraction.test.ts apps/api/tests/setup.ts
git commit -m "feat(entity-search): add entity-extraction resolveAndPersist (Stage 2 persist)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 11: Test + implement alias resolution — reuse an existing Entity, no duplicate canonicalName (failing → pass)

The whole point of canonical entities (spec §3) is that "Bhaijaan", "Sallu", "सलमान" all resolve to one `Entity { canonicalName: "Salman Khan" }` so counts never fragment. When the LLM returns an existing canonical name (because it was given the known-names list and told to reuse), persistence must attach to the existing row, not create a second one.

**Files:**
- Modify: `apps/api/tests/entity-extraction.test.ts` (append a `describe` block)

Steps:

- [ ] **Step 1:** Append the alias-resolution test to `apps/api/tests/entity-extraction.test.ts`. Pre-seed an existing `Salman Khan` entity, then persist a second caption whose alias the LLM resolved back to the same canonical name — assert exactly one entity exists with two join rows:

```ts
  describe("alias resolution — reuses an existing Entity (no count fragmentation)", () => {
    it("attaches an aliased caption to the existing canonical Entity, never a duplicate", async () => {
      // Existing canonical entity (created on an earlier extraction run).
      const existing = await prisma.entity.create({
        data: { canonicalName: "Salman Khan", type: "PERSON", aliases: ["bhaijaan"] },
      });
      const first = await seedContent({ canonicalKey: "yt:aaaaaaaaaaa", caption: "Salman Khan interview" });
      await resolveAndPersist(first.id, [
        { canonicalName: "Salman Khan", type: "PERSON", confidence: 1, isNew: false },
      ]);

      // New caption — the LLM saw "Salman Khan" in the known-names list and resolved
      // the alias "Bhaijaan" back to it (isNew:false, same canonicalName).
      const second = await seedContent({ canonicalKey: "yt:bbbbbbbbbbb", caption: "Bhaijaan ki nayi film" });
      await resolveAndPersist(second.id, [
        { canonicalName: "Salman Khan", type: "PERSON", confidence: 0.9, isNew: false },
      ]);

      const entities = await prisma.entity.findMany();
      expect(entities).toHaveLength(1); // NOT 2 — counts never fragment
      expect(entities[0].id).toBe(existing.id);

      const joins = await prisma.linkContentEntity.findMany({ where: { entityId: existing.id } });
      expect(joins).toHaveLength(2); // both posts attached to the one canonical entity
    });
  });
```

- [ ] **Step 2:** Run the test:

```bash
npm run test -w @dashmani/api -- entity-extraction
```

Expected: `2 passed`. The existing `upsert({ where: { canonicalName } })` in `resolveAndPersist` already attaches to the existing row by its UNIQUE `canonicalName` — no code change needed; this test locks that behavior in so a future refactor can't reintroduce fragmentation.

- [ ] **Step 3:** Commit:

```bash
git add apps/api/tests/entity-extraction.test.ts
git commit -m "test(entity-search): lock alias resolution to a single canonical Entity

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 12: Add alias-merge — when the LLM surfaces a new alias for a known entity, store it (failing → pass)

The Entity table powers autocomplete and future admin merge/rename (spec §3). When the LLM resolves a caption to an existing canonical name *and* the raw caption surfaced a new alias not yet stored, we should add that alias to the entity's `aliases[]` so future fuzzy search matches it. This is additive — never removes aliases, never overwrites the canonical name. The LLM response is extended with an optional `aliasUsed` field (the surface form it resolved from).

**Files:**
- Modify: `apps/api/src/services/entity-extraction.service.ts` (`LlmEntity` interface + `resolveAndPersist`)
- Modify: `apps/api/tests/entity-extraction.test.ts` (append a test)

Steps:

- [ ] **Step 1:** Append the alias-merge test to `apps/api/tests/entity-extraction.test.ts`:

```ts
  describe("alias merge — a newly-surfaced alias is stored on the existing entity", () => {
    it("adds aliasUsed to aliases[] without duplicating it or touching canonicalName", async () => {
      const existing = await prisma.entity.create({
        data: { canonicalName: "Salman Khan", type: "PERSON", aliases: ["bhaijaan"] },
      });
      const content = await seedContent({ canonicalKey: "yt:ccccccccccc", caption: "Sallu bhai on set" });

      await resolveAndPersist(content.id, [
        { canonicalName: "Salman Khan", type: "PERSON", confidence: 0.8, isNew: false, aliasUsed: "sallu" },
      ]);

      const e = await prisma.entity.findUniqueOrThrow({ where: { id: existing.id } });
      expect(e.canonicalName).toBe("Salman Khan");
      expect(e.aliases.sort()).toEqual(["bhaijaan", "sallu"]); // additive, deduped

      // Re-running with the same alias must not duplicate it.
      await resolveAndPersist(content.id, [
        { canonicalName: "Salman Khan", type: "PERSON", confidence: 0.8, isNew: false, aliasUsed: "sallu" },
      ]);
      const e2 = await prisma.entity.findUniqueOrThrow({ where: { id: existing.id } });
      expect(e2.aliases.sort()).toEqual(["bhaijaan", "sallu"]);
    });
  });
```

- [ ] **Step 2:** Add the optional `aliasUsed` field to the `LlmEntity` interface in `apps/api/src/services/entity-extraction.service.ts`:

```ts
export interface LlmEntity {
  canonicalName: string;
  type: string; // PERSON | TOPIC | BRAND | OTHER
  confidence: number;
  isNew: boolean;
  aliasUsed?: string | null; // the surface form the LLM resolved from (e.g. "sallu"), if not the canonical name
}
```

- [ ] **Step 3:** In `resolveAndPersist`, after the `entity` upsert and before the join upsert, merge a freshly-surfaced alias. Replace the `prisma.entity.upsert(...)` block plus the alias logic with:

```ts
    const entity = await prisma.entity.upsert({
      where: { canonicalName },
      update: {},
      create: { canonicalName, type, aliases: [] },
    });

    // Additive alias merge: if the LLM resolved from a surface form not already
    // stored (and distinct from the canonical name), append it. Never removes,
    // never overwrites the canonical name — powers future fuzzy search.
    const alias = (e.aliasUsed ?? "").trim().toLowerCase();
    if (alias && alias !== canonicalName.toLowerCase() && !entity.aliases.includes(alias)) {
      await prisma.entity.update({
        where: { id: entity.id },
        data: { aliases: { push: alias } },
      });
    }
```

- [ ] **Step 4:** Run the test:

```bash
npm run test -w @dashmani/api -- entity-extraction
```

Expected: `3 passed`.

- [ ] **Step 5:** Commit:

```bash
git add apps/api/src/services/entity-extraction.service.ts apps/api/tests/entity-extraction.test.ts
git commit -m "feat(entity-search): merge newly-surfaced aliases into the canonical entity (additive)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 13: Test defensive parsing — malformed LLM response marks the row `error` and never throws (failing → pass)

Per spec §6, a parse failure must mark that one row `status='error'` and continue — never throw the batch. This is where `extractEntitiesFromContent` (the LLM-calling half) plus a `processContentRow` wrapper come in. The test injects a fake `extractFn` that returns junk for one caption and valid JSON for another, then asserts: the junk row is `error`, the good row is `ok` + extracted, and no exception escaped.

**Files:**
- Modify: `apps/api/src/services/entity-extraction.service.ts` (add `parseLlmEntities`, `processContentRow`)
- Modify: `apps/api/tests/entity-extraction.test.ts` (append a test)

Steps:

- [ ] **Step 1:** Append the defensive-parsing test to `apps/api/tests/entity-extraction.test.ts`. Import `parseLlmEntities` and `processContentRow` (added below):

```ts
  describe("defensive parsing — bad LLM output marks the row error, never throws", () => {
    it("parseLlmEntities returns null on non-JSON / wrong-shape, array on valid", () => {
      expect(parseLlmEntities("not json at all")).toBeNull();
      expect(parseLlmEntities('{"oops":"object not array"}')).toBeNull();
      expect(parseLlmEntities("[]")).toEqual([]);
      const ok = parseLlmEntities(
        '```json\n[{"canonicalName":"Salman Khan","type":"PERSON","confidence":0.9,"isNew":true}]\n```',
      );
      expect(ok).toHaveLength(1);
      expect(ok![0].canonicalName).toBe("Salman Khan");
    });

    it("processContentRow marks a row error on parse failure and ok on success — and does not throw", async () => {
      const bad = await seedContent({ canonicalKey: "yt:ddddddddddd", caption: "garbage caption" });
      const good = await seedContent({ canonicalKey: "yt:eeeeeeeeeee", caption: "Aamir Khan documentary" });

      // Fake the raw LLM text response: junk for bad, valid JSON for good.
      const fakeRaw = async (input: { caption: string }) =>
        input.caption === "garbage caption"
          ? "I cannot help with that"
          : '[{"canonicalName":"Aamir Khan","type":"PERSON","confidence":0.92,"isNew":true}]';

      // Must NOT throw, even though one row's response is unparseable.
      await processContentRow(bad, [], fakeRaw);
      await processContentRow(good, ["Aamir Khan"], fakeRaw);

      const badAfter = await prisma.linkContent.findUniqueOrThrow({ where: { id: bad.id } });
      expect(badAfter.status).toBe("error");
      expect(badAfter.extractedAt).toBeNull(); // not stamped — but it WILL be skipped (status != ok)

      const goodAfter = await prisma.linkContent.findUniqueOrThrow({ where: { id: good.id } });
      expect(goodAfter.status).toBe("ok");
      expect(goodAfter.extractedAt).not.toBeNull();
      const ents = await prisma.entity.findMany();
      expect(ents.map((e) => e.canonicalName)).toContain("Aamir Khan");
    });
  });
```

- [ ] **Step 2:** Add `parseLlmEntities` and `processContentRow` to `apps/api/src/services/entity-extraction.service.ts`. `processContentRow` takes the content row, the known-names list, and an injectable `rawFn` (the LLM-text producer — defaults to the real Claude call added in Task 6). Add after `resolveAndPersist`:

```ts
/**
 * Parse the LLM's strict-JSON response. Tolerates ```json fences. Returns null
 * (never throws) on anything that isn't a JSON array of the expected shape.
 */
export function parseLlmEntities(raw: string): LlmEntity[] | null {
  try {
    const cleaned = raw.replace(/```json\n?/gi, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter((x) => x && typeof x === "object" && typeof x.canonicalName === "string")
      .map((x) => ({
        canonicalName: String(x.canonicalName),
        type: typeof x.type === "string" ? x.type : "OTHER",
        confidence: typeof x.confidence === "number" ? x.confidence : 1,
        isNew: x.isNew === true,
        aliasUsed: typeof x.aliasUsed === "string" ? x.aliasUsed : null,
      }));
  } catch {
    return null;
  }
}

/** A function that, given a caption/title, returns the raw LLM text response. */
export type RawExtractFn = (input: { caption: string; title: string | null; knownNames: string[] }) => Promise<string>;

type ContentRow = { id: string; caption: string | null; title: string | null };

/**
 * Process ONE LinkContent row end-to-end:
 *   call LLM → parse → on parse failure mark status='error' (and CONTINUE),
 *   on success persist entities + stamp extractedAt.
 * Wrapped so a single bad row never throws the batch (spec §6).
 * `rawFn` is injectable for tests; production passes the Claude caller (Task 6).
 */
export async function processContentRow(
  content: ContentRow,
  knownNames: string[],
  rawFn: RawExtractFn,
): Promise<{ status: "ok" | "error" }> {
  try {
    const raw = await rawFn({
      caption: content.caption ?? "",
      title: content.title ?? null,
      knownNames,
    });
    const parsed = parseLlmEntities(raw);
    if (parsed === null) {
      await prisma.linkContent.update({ where: { id: content.id }, data: { status: "error" } });
      return { status: "error" };
    }
    await resolveAndPersist(content.id, parsed);
    return { status: "ok" };
  } catch (err) {
    console.error(`[entity-extraction] row ${content.id} failed:`, err);
    try {
      await prisma.linkContent.update({ where: { id: content.id }, data: { status: "error" } });
    } catch (markErr) {
      console.error(`[entity-extraction] could not mark row ${content.id} error:`, markErr);
    }
    return { status: "error" };
  }
}
```

- [ ] **Step 3:** Run the test:

```bash
npm run test -w @dashmani/api -- entity-extraction
```

Expected: `5 passed`.

- [ ] **Step 4:** Commit:

```bash
git add apps/api/src/services/entity-extraction.service.ts apps/api/tests/entity-extraction.test.ts
git commit -m "feat(entity-search): defensive LLM-response parse; bad row -> status=error, never throws batch

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 14: Add the real Claude Haiku caller `extractEntitiesFromContent` (verification-based)

This is the only step that touches Anthropic. It follows `ai.service.ts` byte-for-byte: `import Anthropic from "@anthropic-ai/sdk"`, a lazy `getClient()` singleton that throws `AppError(500, "AI_NOT_CONFIGURED", ...)` when `ANTHROPIC_API_KEY` is missing, and `client.messages.create({ model, max_tokens, system, messages })`. Model is Haiku (`claude-haiku-4-5-20251001`). The prompt contract gives the model the caption + title + known canonical names and demands a strict JSON array. It is verification-based (tsc + a controlled live smoke against one caption), because hitting the live model in a unit test is non-deterministic — the parsing/persistence logic was already TDD'd against an injected `rawFn` in Tasks 1–5.

**Files:**
- Modify: `apps/api/src/services/entity-extraction.service.ts` (add `getClient`, `extractEntitiesFromContent`)

Steps:

- [ ] **Step 1:** At the top of `apps/api/src/services/entity-extraction.service.ts`, add the Anthropic import and the lazy client (matching `ai.service.ts` lines 1–14). Add `import Anthropic from "@anthropic-ai/sdk";` and `import { AppError } from "../middleware/error-handler";` alongside the existing `import { prisma } from "@dashmani/db";`, then:

```ts
let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new AppError(500, "AI_NOT_CONFIGURED", "AI service is not configured. Set ANTHROPIC_API_KEY.");
  }
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
```

- [ ] **Step 2:** Add `extractEntitiesFromContent` (the production `RawExtractFn`) below `getClient`. The prompt: given caption+title and the current known canonical names, return STRICT JSON only, reuse an existing name when the person matches (resolve aliases incl. Devanagari/Roman variants), and `isNew:true` only when genuinely unseen:

```ts
/**
 * Production RawExtractFn: asks Claude Haiku to extract canonical entities from
 * one caption/title, told to REUSE an existing canonical name when the person
 * matches (resolving aliases like "Bhaijaan"/"Sallu"/"सलमान" → "Salman Khan").
 * Returns the raw model text; parsing/validation happens in parseLlmEntities.
 */
export const extractEntitiesFromContent: RawExtractFn = async ({ caption, title, knownNames }) => {
  const client = getClient();

  const system = `You extract the real-world people, brands, and topics that a social-media post is ABOUT, from its caption and title.

Rules:
- Resolve aliases, nicknames, handles, and other scripts (e.g. Devanagari) to one canonical English name. "Bhaijaan", "Sallu", "@beingsalmankhan", "सलमान" all → "Salman Khan".
- You are given a list of KNOWN canonical names. If a person/brand/topic in this post matches one, REUSE that exact canonical name and set "isNew": false. Only set "isNew": true for a genuinely unseen entity.
- "type" is one of: PERSON, BRAND, TOPIC, OTHER.
- "confidence" is 0.0–1.0.
- If you resolved from a surface form different from the canonical name, put that surface form in "aliasUsed" (lowercase), else omit it.
- If the post is about nobody identifiable, return [].
- Return ONLY a JSON array. No prose, no markdown, no code fences.`;

  const knownBlock = knownNames.length
    ? `Known canonical names (reuse exact spelling when matched):\n${knownNames.map((n) => `- ${n}`).join("\n")}`
    : "Known canonical names: (none yet)";

  const userPrompt = `${knownBlock}

Title: ${title ?? "(none)"}
Caption: ${caption || "(empty)"}

Return a JSON array of: { "canonicalName": string, "type": "PERSON"|"BRAND"|"TOPIC"|"OTHER", "confidence": number, "isNew": boolean, "aliasUsed"?: string }`;

  const msg = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: userPrompt }],
  });
  const block = msg.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text : "";
};
```

- [ ] **Step 3:** Verify it compiles (no live call — tsc only):

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: no errors.

- [ ] **Step 4:** Re-run the extraction tests to confirm the new export didn't break the injected-`rawFn` tests:

```bash
npm run test -w @dashmani/api -- entity-extraction
```

Expected: `5 passed` (unchanged — the live caller is not exercised by tests).

- [ ] **Step 5:** Controlled live smoke (manual, only if `ANTHROPIC_API_KEY` is set locally — confirms the model/prompt actually returns parseable JSON). Write a throwaway one-liner under the scratchpad and run it:

```bash
cd /Users/tabish/Desktop/dashmani-platform/apps/api && npx tsx -e "import('./src/services/entity-extraction.service').then(async m => { const raw = await m.extractEntitiesFromContent({ caption: 'Exclusive interview with Salman Khan about his upcoming film', title: null, knownNames: [] }); console.log('RAW:', raw); console.log('PARSED:', JSON.stringify(m.parseLlmEntities(raw))); })"
```

Expected: `PARSED:` prints a JSON array containing `{"canonicalName":"Salman Khan",...}`. If `AI_NOT_CONFIGURED` throws, the key isn't set locally — that's fine, skip this smoke (it is covered in prod where the key is present).

- [ ] **Step 6:** Commit:

```bash
git add apps/api/src/services/entity-extraction.service.ts
git commit -m "feat(entity-search): Claude Haiku entity extractor (ai.service.ts pattern, AI_NOT_CONFIGURED guard)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 15: Test + implement `runEntityExtraction` batch runner — idempotent, bounded (failing → pass)

`runEntityExtraction` is the engine both the cron and the backfill script call. It selects `LinkContent WHERE status='ok' AND extractedAt IS NULL`, processes at most `BATCH_CAP` (500) rows per call (logging how many were skipped), and re-fetches the known-names list once up front. Idempotency is the load-bearing property: a row already extracted (`extractedAt` set) must never be re-paid. The test injects `rawFn` so it never calls the network.

**Files:**
- Modify: `apps/api/src/services/entity-extraction.service.ts` (add `BATCH_CAP`, `runEntityExtraction`)
- Modify: `apps/api/tests/entity-extraction.test.ts` (append a test)

Steps:

- [ ] **Step 1:** Append the batch-runner test to `apps/api/tests/entity-extraction.test.ts`. It proves (a) only un-extracted `ok` rows are picked, (b) an already-`extractedAt` row is skipped (idempotency — its `rawFn` is never called), and (c) a second run does nothing:

```ts
  describe("runEntityExtraction — selects un-extracted ok rows, idempotent", () => {
    it("processes only status=ok AND extractedAt IS NULL, and never re-pays a done row", async () => {
      // Eligible: ok + not yet extracted
      await seedContent({ canonicalKey: "yt:fffffffffff", caption: "Shah Rukh Khan new movie" });
      // Already extracted — must be skipped (no rawFn call)
      await seedContent({ canonicalKey: "yt:ggggggggggg", caption: "old one", extractedAt: new Date() });
      // Not ok — must be skipped
      await seedContent({ canonicalKey: "yt:hhhhhhhhhhh", caption: "private", status: "private" });

      const seen: string[] = [];
      const rawFn = async (input: { caption: string }) => {
        seen.push(input.caption);
        return '[{"canonicalName":"Shah Rukh Khan","type":"PERSON","confidence":0.9,"isNew":true}]';
      };

      const res1 = await runEntityExtraction(rawFn);
      expect(res1.processed).toBe(1);
      expect(seen).toEqual(["Shah Rukh Khan new movie"]); // only the eligible row's caption hit the LLM
      expect(await prisma.entity.count()).toBe(1);

      // Second run: the only eligible row is now extracted → nothing to do, no LLM calls.
      const res2 = await runEntityExtraction(rawFn);
      expect(res2.processed).toBe(0);
      expect(seen).toHaveLength(1); // unchanged — idempotent, never re-pays
    });
  });
```

- [ ] **Step 2:** Add `BATCH_CAP` and `runEntityExtraction` to `apps/api/src/services/entity-extraction.service.ts`. It defaults `rawFn` to the production `extractEntitiesFromContent` so the cron/script can call it with no args; the test passes an injected fake. Add after `processContentRow`:

```ts
const BATCH_CAP = 500; // max captions per run — caps cost + keeps the event loop responsive

/**
 * Run one extraction pass: pick up to BATCH_CAP un-extracted, status='ok' rows,
 * call the LLM per row, persist. Idempotent — extractedAt rows are excluded by
 * the WHERE clause so a row is never re-extracted (never re-paid).
 * rawFn defaults to the live Claude caller; injectable for tests.
 */
export async function runEntityExtraction(
  rawFn: RawExtractFn = extractEntitiesFromContent,
): Promise<{ processed: number; ok: number; errored: number; skipped: number }> {
  const total = await prisma.linkContent.count({ where: { status: "ok", extractedAt: null } });
  const rows = await prisma.linkContent.findMany({
    where: { status: "ok", extractedAt: null },
    select: { id: true, caption: true, title: true },
    orderBy: { createdAt: "asc" },
    take: BATCH_CAP,
  });

  // Snapshot the known canonical names once for this run (the prompt's reuse list).
  const known = await prisma.entity.findMany({ select: { canonicalName: true } });
  const knownNames = known.map((e) => e.canonicalName);

  let ok = 0;
  let errored = 0;
  for (const row of rows) {
    const r = await processContentRow(row, knownNames, rawFn);
    if (r.status === "ok") ok++;
    else errored++;
  }

  const skipped = Math.max(0, total - rows.length);
  return { processed: rows.length, ok, errored, skipped };
}
```

- [ ] **Step 3:** Run the test:

```bash
npm run test -w @dashmani/api -- entity-extraction
```

Expected: `7 passed`.

- [ ] **Step 4:** Commit:

```bash
git add apps/api/src/services/entity-extraction.service.ts apps/api/tests/entity-extraction.test.ts
git commit -m "feat(entity-search): runEntityExtraction batch runner (bounded BATCH_CAP=500, idempotent)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 16: Create `entity-extraction.cron.ts` (verification-based)

A thin cron wrapper around `runEntityExtraction`, mirroring `social-insights.cron.ts`: it logs start/done with counts and is its own isolated unit. It must NOT touch the metrics path or the social-insights cron. If `ANTHROPIC_API_KEY` is missing, `runEntityExtraction` → `extractEntitiesFromContent` → `getClient()` throws `AppError(500, AI_NOT_CONFIGURED)`; the cron's caller (`.catch` in `index.ts`, Task 9) swallows it so the rest of the API is unaffected.

**Files:**
- Create: `apps/api/src/cron/entity-extraction.cron.ts`

Steps:

- [ ] **Step 1:** Create `apps/api/src/cron/entity-extraction.cron.ts`:

```ts
import { runEntityExtraction } from "../services/entity-extraction.service";

/**
 * Stage 2 cron — extract canonical entities from un-extracted LinkContent captions
 * via Claude Haiku. Bounded per run (BATCH_CAP in the service). Fully isolated from
 * the social-insights metrics cron: it reads link_content and writes entities/joins
 * only — it never touches report_links or link_metrics.
 *
 * If ANTHROPIC_API_KEY is missing, runEntityExtraction throws AI_NOT_CONFIGURED;
 * the bootstrap's .catch in index.ts logs it and the rest of the API is unaffected.
 */
export async function runEntityExtraction6h(): Promise<void> {
  const startedAt = Date.now();
  console.log(`[entity-extraction] starting at ${new Date().toISOString()}`);
  const { processed, ok, errored, skipped } = await runEntityExtraction();
  console.log(
    `[entity-extraction] ${processed} processed (${ok} ok, ${errored} error), ${skipped} skipped (over BATCH_CAP) — ${Date.now() - startedAt}ms`,
  );
}
```

- [ ] **Step 2:** Verify it compiles:

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: no errors.

- [ ] **Step 3:** Commit:

```bash
git add apps/api/src/cron/entity-extraction.cron.ts
git commit -m "feat(entity-search): entity-extraction 6h cron (isolated; never touches metrics path)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 17: Wire the cron into `index.ts` — same setInterval + .catch pattern (verification-based)

Bootstrap `runEntityExtraction6h` next to `runInsights` using the exact existing pattern: run once on startup, then `setInterval(..., 6h)`, with a `.catch(console.error)` so a missing key or Anthropic outage logs and no-ops without crashing the server (spec §8.4). The social-insights bootstrap must remain byte-identical.

**Files:**
- Modify: `apps/api/src/index.ts` (import line + bootstrap block, lines 1–24)

Steps:

- [ ] **Step 1:** Add the import after the existing `runSocialInsightsRefresh` import (line 4):

```ts
import { runEntityExtraction6h } from "./cron/entity-extraction.cron";
```

- [ ] **Step 2:** Add the bootstrap block immediately after the existing social-insights `setInterval` (after line 23, inside the `app.listen` callback). Do NOT modify the existing `runFollowerSync` or `runInsights` blocks:

```ts
  // Run entity extraction (Stage 2) once on startup, then every 6 hours.
  // Isolated: its own try/catch via .catch — a missing ANTHROPIC_API_KEY or
  // Anthropic outage logs and no-ops; the rest of the API is unaffected.
  const runExtraction = () => {
    runEntityExtraction6h().catch((err) => console.error("[entity-extraction] error:", err));
  };
  runExtraction();
  setInterval(runExtraction, 6 * 60 * 60 * 1000);
```

- [ ] **Step 3:** Verify it compiles:

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: no errors.

- [ ] **Step 4:** Sanity-check the server boots without crashing even with no key (the extraction cron should log AI_NOT_CONFIGURED and the API stays up). Start it, wait for the startup log, then kill it:

```bash
cd /Users/tabish/Desktop/dashmani-platform && (ANTHROPIC_API_KEY= npm run dev -w @dashmani/api &) ; sleep 8 ; curl -s http://localhost:4000/v1/health ; lsof -ti:4000 | xargs kill 2>/dev/null
```

Expected: `{"success":true,...}` from `/v1/health` (the API stayed up). The console will show `[entity-extraction] error: ... AI_NOT_CONFIGURED` if no key is set — that is the intended isolated-failure behavior, not a crash.

- [ ] **Step 5:** Commit:

```bash
git add apps/api/src/index.ts
git commit -m "feat(entity-search): bootstrap entity-extraction cron in index.ts (6h, isolated .catch)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 18: Create `scripts/extract-entities.ts` — dry-run-default bulk backfill (verification-based)

The one-time backfill that pushes all ~27k (today: 431 YouTube) captions through Haiku under manual supervision. Follows the repo script convention exactly (dry-run by default; `--apply` + `--confirm-prod` to write; run via `cd packages/db && npx tsx ../../scripts/extract-entities.ts`). Dry-run reports how many rows would be processed and previews a few; apply calls `runEntityExtraction` in a bounded loop until the eligible set is drained, printing progress.

**Files:**
- Create: `scripts/extract-entities.ts`

Steps:

- [ ] **Step 1:** Create `scripts/extract-entities.ts`:

```ts
/**
 * Stage 2 backfill — extract canonical entities from enriched LinkContent captions
 * via Claude Haiku. One-time bulk run; the 6h cron handles the trickle afterward.
 *
 * Usage (dry-run — default, NO writes, NO Anthropic spend):
 *   cd packages/db && npx tsx ../../scripts/extract-entities.ts
 *
 * Usage (apply — calls Claude Haiku + writes entities/joins, requires both flags):
 *   cd packages/db && npx tsx ../../scripts/extract-entities.ts --apply --confirm-prod
 *
 * ALWAYS back up before --apply on prod:
 *   pg_dump dashmani_prod > /tmp/backup_$(date +%Y%m%d_%H%M%S).sql
 *
 * Bounded per loop iteration by the service's BATCH_CAP (500) so a backfill can't
 * spike the Anthropic bill or block the event loop. ~27k Haiku captions ≈ cents.
 * Idempotent: only status='ok' AND extractedAt IS NULL rows are touched, so re-running
 * after an interruption resumes where it stopped and never re-pays a done row.
 */
import { PrismaClient } from "@prisma/client";
import { runEntityExtraction } from "../apps/api/src/services/entity-extraction.service";

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const CONFIRM_PROD = args.includes("--confirm-prod");
const DRY_RUN = !APPLY;

if (APPLY && !CONFIRM_PROD) {
  console.error(
    "\n[ERROR] --apply requires --confirm-prod to prevent accidental production writes / Anthropic spend.\n" +
      "Run: npx tsx ../../scripts/extract-entities.ts --apply --confirm-prod\n",
  );
  process.exit(1);
}

async function main() {
  const eligible = await prisma.linkContent.count({ where: { status: "ok", extractedAt: null } });
  console.log(`\n${DRY_RUN ? "[DRY-RUN]" : "[APPLY]  "} ${eligible} LinkContent rows eligible (status=ok, extractedAt IS NULL)`);

  if (DRY_RUN) {
    const preview = await prisma.linkContent.findMany({
      where: { status: "ok", extractedAt: null },
      select: { canonicalKey: true, platform: true, title: true, caption: true },
      take: 5,
      orderBy: { createdAt: "asc" },
    });
    for (const p of preview) {
      const text = (p.title || p.caption || "").slice(0, 80);
      console.log(`  [DRY-RUN] would extract ${p.platform} ${p.canonicalKey} :: "${text}"`);
    }
    console.log(`\n[DRY-RUN] No Anthropic calls made, no writes. Re-run with --apply --confirm-prod to extract.\n`);
    return;
  }

  // APPLY: drain the eligible set in BATCH_CAP-sized passes via the service.
  let totalProcessed = 0;
  let totalOk = 0;
  let totalErr = 0;
  for (;;) {
    const { processed, ok, errored, skipped } = await runEntityExtraction(); // uses live Claude Haiku
    totalProcessed += processed;
    totalOk += ok;
    totalErr += errored;
    console.log(`[APPLY]   pass: ${processed} processed (${ok} ok, ${errored} error), ${skipped} remaining`);
    if (processed === 0) break; // nothing left eligible — done
  }
  console.log(`\n[APPLY]   DONE — ${totalProcessed} processed (${totalOk} ok, ${totalErr} error)\n`);
}

main()
  .catch((err) => {
    console.error("[extract-entities] fatal:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
```

- [ ] **Step 2:** Verify the script type-checks and the dry-run path runs without writing or calling Anthropic. Dry-run requires no key:

```bash
cd /Users/tabish/Desktop/dashmani-platform/packages/db && npx tsx ../../scripts/extract-entities.ts
```

Expected: prints `[DRY-RUN] N LinkContent rows eligible ...` and `No Anthropic calls made, no writes.` (N is 0 on a fresh local DB with no enriched content yet — that is correct; the script is proven to query and report). Confirm it made no writes:

```bash
cd /Users/tabish/Desktop/dashmani-platform/packages/db && npx tsx -e "import('@prisma/client').then(async ({PrismaClient}) => { const p = new PrismaClient(); console.log('entities after dry-run:', await p.entity.count()); await p.\$disconnect(); })"
```

Expected: `entities after dry-run: 0`.

- [ ] **Step 3:** Confirm the `--apply` guard rejects a missing `--confirm-prod`:

```bash
cd /Users/tabish/Desktop/dashmani-platform/packages/db && npx tsx ../../scripts/extract-entities.ts --apply ; echo "exit=$?"
```

Expected: the `[ERROR] --apply requires --confirm-prod` message and `exit=1`.

- [ ] **Step 4:** Commit:

```bash
git add scripts/extract-entities.ts
git commit -m "feat(entity-search): scripts/extract-entities.ts bulk backfill (dry-run default, --apply --confirm-prod)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 19: Full extraction-suite green + tsc gate (verification-based)

Final gate for Phase C: the seven extraction tests pass on their own (the ~36 pre-existing analytics/content/task/team failures are not ours and are excluded by the path filter), and `apps/api` + `packages/shared` type-check clean.

**Files:** none (verification only)

Steps:

- [ ] **Step 1:** Run the full extraction suite in isolation:

```bash
npm run test -w @dashmani/api -- entity-extraction
```

Expected: `Test Files 1 passed`, `Tests 7 passed` — covering happy-path persist, alias resolution (no fragmentation), alias merge, defensive parse (`error`, no throw), and batch-runner idempotency.

- [ ] **Step 2:** tsc gate on the touched packages:

```bash
npx tsc --noEmit -p apps/api/tsconfig.json && cd /Users/tabish/Desktop/dashmani-platform && npx tsc --noEmit -p packages/shared/tsconfig.json
```

Expected: no errors. (No frontend changed in Phase C, so the full `npm run build` gate from spec §8.7 belongs to the UI phase, not here — but `apps/api` must tsc clean before any push.)

- [ ] **Step 3:** No commit — this is a verification gate. If anything is red, fix forward in the relevant task above before proceeding to the next phase.

## Phase D — Stage 3 Search API (admin endpoint, same-vs-unique)

> **Pre-req:** Phase A's three additive tables (`entities`, `link_content`, `link_content_entities` → Prisma clients `prisma.entity`, `prisma.linkContent`, `prisma.linkContentEntity`) exist and `npm run db:generate` has been run, so the Prisma client types are available. These tables are **not** in `apps/api/tests/setup.ts`'s `TRUNCATE` list (that file truncates existing tables only); the test in this phase therefore cleans the three new tables itself in `beforeEach` (see Task 1). Do **not** edit `setup.ts` — leave the existing truncate list byte-identical.

### Task 20: Failing test for `searchLinksByEntity` — total vs unique vs duplicate counting

Drive out the core same-vs-unique aggregation: the same `canonicalKey` submitted by multiple employees/reports must be counted as multiple `totalPosts` but one `uniquePosts`, never collapsed away.

Files:
- Create `apps/api/tests/link-search.test.ts`

Steps:

- [ ] **Step 1:** Create `apps/api/tests/link-search.test.ts` with the imports, the new-table cleanup, and a shared seed helper. The seed builds: 2 entities (`Salman Khan` with alias `bhaijaan`, and `Shah Rukh Khan`), 2 platforms (Instagram, YouTube), 2 employees, 2 accounts, and `ReportLink` rows where **the same `canonicalKey` (`ig:CxYz123`) appears on TWO different employees' reports** (a genuine duplicate) plus distinct keys. `LinkContent` + `LinkContentEntity` link those keys to `Salman Khan`.

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@dashmani/db";
import { canonicalKey } from "@dashmani/shared";
import { searchLinksByEntity } from "../src/services/link-search.service";
import "./setup";

// setup.ts does NOT truncate the three additive tables — clean them here.
// Order matters: child join rows before parents.
async function cleanLinkEntityTables() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE link_content_entities, link_content, entities CASCADE`,
  );
}

const IG = "https://instagram.com/reel/CxYz123/?igsh=tok1"; // ig:CxYz123
const IG_DUP = "https://instagram.com/reel/CxYz123/?igsh=DIFFERENT"; // SAME key ig:CxYz123
const IG_OTHER = "https://instagram.com/reel/AbCd999/"; // ig:AbCd999
const YT = "https://youtube.com/watch?v=dQw4w9WgXcQ"; // yt:dQw4w9WgXcQ

async function seed() {
  const [ig, yt] = await Promise.all([
    prisma.platform.create({ data: { name: "Instagram", slug: "instagram" } }),
    prisma.platform.create({ data: { name: "YouTube", slug: "youtube" } }),
  ]);

  const e1 = await prisma.user.create({
    data: { name: "Emp One", email: `e1-${Date.now()}@t.com`, passwordHash: "x", status: "ACTIVE" },
  });
  const e2 = await prisma.user.create({
    data: { name: "Emp Two", email: `e2-${Date.now()}@t.com`, passwordHash: "x", status: "ACTIVE" },
  });

  const accA = await prisma.socialAccount.create({
    data: { handle: "@chanA", displayName: "Channel A", platformId: ig.id },
  });
  const accB = await prisma.socialAccount.create({
    data: { handle: "@chanB", displayName: "Channel B", platformId: yt.id },
  });

  // Two reports — same date, two employees.
  const r1 = await prisma.dailyReport.create({
    data: { employeeId: e1.id, date: new Date("2026-06-20") },
  });
  const r2 = await prisma.dailyReport.create({
    data: { employeeId: e2.id, date: new Date("2026-06-20") },
  });

  // ig:CxYz123 appears on BOTH reports (a real duplicate post).
  await prisma.reportLink.create({
    data: { reportId: r1.id, accountId: accA.id, url: IG, platform: "Instagram" },
  });
  await prisma.reportLink.create({
    data: { reportId: r2.id, accountId: accA.id, url: IG_DUP, platform: "Instagram" },
  });
  // A distinct IG post on the same account, e1.
  await prisma.reportLink.create({
    data: { reportId: r1.id, accountId: accA.id, url: IG_OTHER, platform: "Instagram" },
  });
  // A YouTube post on a different account, e1 — entity present, distinct channel.
  await prisma.reportLink.create({
    data: { reportId: r1.id, accountId: accB.id, url: YT, platform: "YouTube" },
  });

  // Entities: Salman (matched) + Shah Rukh (a second entity so disambiguation is exercisable).
  const salman = await prisma.entity.create({
    data: { canonicalName: "Salman Khan", type: "PERSON", aliases: ["bhaijaan", "sallu"] },
  });
  await prisma.entity.create({
    data: { canonicalName: "Shah Rukh Khan", type: "PERSON", aliases: ["srk"] },
  });

  // LinkContent for each unique canonicalKey featuring Salman: ig:CxYz123, ig:AbCd999, yt:dQw4w9WgXcQ.
  // ig:AbCd999 is enriched but NOT yet extracted (extractedAt null) → coverage check.
  const lcDup = await prisma.linkContent.create({
    data: { canonicalKey: canonicalKey(IG), platform: "instagram", status: "ok", extractedAt: new Date() },
  });
  await prisma.linkContent.create({
    data: { canonicalKey: canonicalKey(IG_OTHER), platform: "instagram", status: "ok", extractedAt: null },
  });
  const lcYt = await prisma.linkContent.create({
    data: { canonicalKey: canonicalKey(YT), platform: "youtube", status: "ok", extractedAt: new Date() },
  });

  // Salman features in the duplicate IG post and the YouTube post (NOT in ig:AbCd999).
  await prisma.linkContentEntity.create({
    data: { linkContentId: lcDup.id, entityId: salman.id, confidence: 0.95 },
  });
  await prisma.linkContentEntity.create({
    data: { linkContentId: lcYt.id, entityId: salman.id, confidence: 0.9 },
  });

  return { e1, e2, accA, accB };
}

describe("searchLinksByEntity", () => {
  beforeEach(async () => {
    await cleanLinkEntityTables();
  });

  it("counts every ReportLink row as totalPosts but distinct canonicalKey as uniquePosts", async () => {
    await seed();
    const result = await searchLinksByEntity({ q: "salman" });

    expect(result.kind).toBe("match");
    if (result.kind !== "match") return;

    // ig:CxYz123 (x2 rows) + yt:dQw4w9WgXcQ (x1 row) = 3 total rows feature Salman.
    expect(result.totalPosts).toBe(3);
    // distinct canonicalKey: ig:CxYz123, yt:dQw4w9WgXcQ = 2.
    expect(result.uniquePosts).toBe(2);
    expect(result.duplicatePosts).toBe(1); // 3 - 2
  });
});
```

- [ ] **Step 2:** Run the test — it MUST fail because the service file does not exist yet:

```bash
npm run test -w @dashmani/api -- link-search.test.ts
```

Expected output: a failure like `Failed to resolve import "../src/services/link-search.service"` or `Cannot find module`. This proves the test runs and the impl is genuinely missing.

---

### Task 21: Minimal `searchLinksByEntity` — entity match + total/unique/duplicate

Make Task 1 green with the smallest correct implementation: resolve the entity by ILIKE on `canonicalName` + `aliases`, gather its `canonicalKey`s, fetch every matching `ReportLink`, and count.

Files:
- Create `apps/api/src/services/link-search.service.ts`

Steps:

- [ ] **Step 1:** Create `apps/api/src/services/link-search.service.ts`:

```ts
import { prisma } from "@dashmani/db";
import { canonicalKey } from "@dashmani/shared";

export interface LinkSearchParams {
  q: string;
  from?: string; // YYYY-MM-DD inclusive lower bound on report date
  to?: string; // YYYY-MM-DD inclusive upper bound on report date
  platform?: string; // optional platform slug filter (lowercased)
}

export interface SearchChannel {
  accountId: string;
  handle: string;
  displayName: string;
  platform: string;
  postCount: number;
}

export interface SearchPost {
  canonicalKey: string;
  url: string;
  platform: string;
  account: { id: string; handle: string; displayName: string };
  employee: { id: string; name: string };
  date: string; // YYYY-MM-DD
  dupCount: number; // how many rows share this canonicalKey within the result set
}

export interface SearchCoverage {
  enriched: number; // LinkContent rows with status='ok' for the matched keys
  notYetEnriched: number; // matched keys with no ok LinkContent
  total: number; // total distinct canonicalKeys featuring the entity
  byPlatform: Record<string, { enriched: number; total: number }>;
}

export interface EntityMatchResult {
  kind: "match";
  entity: { canonicalName: string; type: string; aliases: string[] };
  totalPosts: number;
  uniquePosts: number;
  duplicatePosts: number;
  channelCount: number;
  channels: SearchChannel[];
  posts: SearchPost[];
  coverage: SearchCoverage;
}

export interface DisambiguationResult {
  kind: "disambiguation";
  matches: { canonicalName: string; type: string; aliases: string[] }[];
}

export interface NoMatchResult {
  kind: "none";
  query: string;
  coverage: { enriched: number; notYetEnriched: number; total: number };
}

export type LinkSearchResult = EntityMatchResult | DisambiguationResult | NoMatchResult;

function dateKey(d: Date): string {
  // report date is stored as a @db.Date midnight — read its UTC calendar parts.
  return d.toISOString().split("T")[0];
}

export async function searchLinksByEntity(params: LinkSearchParams): Promise<LinkSearchResult> {
  const q = (params.q || "").trim();

  // ── Resolve the entity by fuzzy match on canonicalName OR any alias. ──
  // `has` against the String[] aliases is exact-per-element; ILIKE covers the name.
  const matches = await prisma.entity.findMany({
    where: {
      OR: [
        { canonicalName: { contains: q, mode: "insensitive" } },
        { aliases: { hasSome: [q.toLowerCase()] } },
      ],
    },
    orderBy: { canonicalName: "asc" },
  });

  if (matches.length === 0) {
    // No entity — still report global coverage so the admin sees WHY (built in Task 5).
    const cov = await globalCoverage();
    return { kind: "none", query: q, coverage: cov };
  }
  if (matches.length > 1) {
    return {
      kind: "disambiguation",
      matches: matches.map((m) => ({ canonicalName: m.canonicalName, type: m.type, aliases: m.aliases })),
    };
  }

  const entity = matches[0];

  // ── canonicalKeys featuring this entity (via LinkContentEntity → LinkContent). ──
  const contentLinks = await prisma.linkContentEntity.findMany({
    where: { entityId: entity.id },
    select: { content: { select: { canonicalKey: true, platform: true, status: true } } },
  });
  const keyToPlatform = new Map<string, string>();
  for (const cl of contentLinks) keyToPlatform.set(cl.content.canonicalKey, cl.content.platform);
  const keys = [...keyToPlatform.keys()];

  if (keys.length === 0) {
    return {
      kind: "match",
      entity: { canonicalName: entity.canonicalName, type: entity.type, aliases: entity.aliases },
      totalPosts: 0,
      uniquePosts: 0,
      duplicatePosts: 0,
      channelCount: 0,
      channels: [],
      posts: [],
      coverage: { enriched: 0, notYetEnriched: 0, total: 0, byPlatform: {} },
    };
  }

  // ── Pull every ReportLink, then group by canonicalKey() computed on read. ──
  // (Refined to a DB-side window/platform filter in Task 3.)
  const links = await prisma.reportLink.findMany({
    where: { url: { not: null } },
    select: {
      url: true,
      platform: true,
      account: { select: { id: true, handle: true, displayName: true, platform: { select: { slug: true } } } },
      report: { select: { date: true, employee: { select: { id: true, name: true } } } },
    },
  });

  const matchingRows = links.filter((l) => keyToPlatform.has(canonicalKey(l.url)));

  const totalPosts = matchingRows.length;
  const uniqueKeys = new Set(matchingRows.map((l) => canonicalKey(l.url)));
  const uniquePosts = uniqueKeys.size;
  const duplicatePosts = totalPosts - uniquePosts;

  return {
    kind: "match",
    entity: { canonicalName: entity.canonicalName, type: entity.type, aliases: entity.aliases },
    totalPosts,
    uniquePosts,
    duplicatePosts,
    channelCount: 0, // built in Task 3
    channels: [], // built in Task 3
    posts: [], // built in Task 3
    coverage: { enriched: 0, notYetEnriched: 0, total: 0, byPlatform: {} }, // built in Task 5
  };
}

// Global enrichment coverage across the whole DB (used for the no-match explainer).
async function globalCoverage(): Promise<{ enriched: number; notYetEnriched: number; total: number }> {
  const [enriched, total] = await Promise.all([
    prisma.linkContent.count({ where: { status: "ok" } }),
    prisma.linkContent.count(),
  ]);
  return { enriched, notYetEnriched: total - enriched, total };
}
```

- [ ] **Step 2:** Run the test — it MUST pass now:

```bash
npm run test -w @dashmani/api -- link-search.test.ts
```

Expected output: `1 passed`.

- [ ] **Step 3:** Commit:

```bash
git add apps/api/src/services/link-search.service.ts apps/api/tests/link-search.test.ts
git commit -m "$(cat <<'EOF'
feat(link-search): searchLinksByEntity total/unique/duplicate counting

Resolves an Entity by ILIKE/alias match and counts every matching
ReportLink row as totalPosts while distinct canonicalKey() gives
uniquePosts — same-vs-unique, never collapsed.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 22: Failing test for channels + posts + channelCount

Extend the result to expose distinct channels (with per-channel post counts) and the ungrouped post list with per-post `dupCount`.

Files:
- Modify `apps/api/tests/link-search.test.ts` (add a test inside the existing `describe`)

Steps:

- [ ] **Step 1:** Add this test after the Task 1 test:

```ts
  it("returns distinct channels with postCount and an ungrouped post list with dupCount", async () => {
    const { e1, e2, accA, accB } = await seed();
    const result = await searchLinksByEntity({ q: "salman" });
    expect(result.kind).toBe("match");
    if (result.kind !== "match") return;

    // Two distinct SocialAccounts feature Salman: accA (the IG dup x2) + accB (YouTube x1).
    expect(result.channelCount).toBe(2);

    const chanA = result.channels.find((c) => c.accountId === accA.id)!;
    const chanB = result.channels.find((c) => c.accountId === accB.id)!;
    expect(chanA.postCount).toBe(2); // both IG dup rows on channel A
    expect(chanA.handle).toBe("@chanA");
    expect(chanA.platform).toBe("instagram");
    expect(chanB.postCount).toBe(1);

    // posts list keeps EVERY row (3 total) — nothing collapsed.
    expect(result.posts.length).toBe(3);
    // the ig:CxYz123 rows both carry dupCount 2; the yt row carries dupCount 1.
    const igRows = result.posts.filter((p) => p.canonicalKey === "ig:CxYz123");
    expect(igRows.length).toBe(2);
    expect(igRows.every((p) => p.dupCount === 2)).toBe(true);
    // the two IG rows came from two different employees — both present.
    const igEmployeeIds = igRows.map((p) => p.employee.id).sort();
    expect(igEmployeeIds).toEqual([e1.id, e2.id].sort());
    const ytRow = result.posts.find((p) => p.canonicalKey === "yt:dQw4w9WgXcQ")!;
    expect(ytRow.dupCount).toBe(1);
    expect(ytRow.account.id).toBe(accB.id);
  });

  it("respects the platform filter", async () => {
    await seed();
    const result = await searchLinksByEntity({ q: "salman", platform: "youtube" });
    expect(result.kind).toBe("match");
    if (result.kind !== "match") return;
    // Only the YouTube post survives the filter.
    expect(result.totalPosts).toBe(1);
    expect(result.uniquePosts).toBe(1);
    expect(result.channelCount).toBe(1);
    expect(result.posts[0].canonicalKey).toBe("yt:dQw4w9WgXcQ");
  });

  it("respects the from/to date window", async () => {
    await seed();
    // All seeded reports are on 2026-06-20; a window that excludes it → empty.
    const result = await searchLinksByEntity({ q: "salman", from: "2026-01-01", to: "2026-01-31" });
    expect(result.kind).toBe("match");
    if (result.kind !== "match") return;
    expect(result.totalPosts).toBe(0);
    expect(result.posts.length).toBe(0);
  });
```

- [ ] **Step 2:** Run — the channels/posts test MUST fail (channels/posts are still `[]`, channelCount `0`), and the platform/date-window tests MUST fail (filters not applied yet):

```bash
npm run test -w @dashmani/api -- link-search.test.ts
```

Expected output: `1 passed`, `3 failed`.

- [ ] **Step 3:** Build channels, posts, dupCount, and the `from`/`to`/`platform` filters into the service. Replace the `prisma.reportLink.findMany` block and everything after it (the `matchingRows`/`totalPosts` section through the `return` of the match result) with:

```ts
  // ── DB-side window + platform filter; canonicalKey grouping on read. ──
  const where: any = { url: { not: null } };
  if (params.from || params.to) {
    where.report = { date: {} };
    if (params.from) where.report.date.gte = new Date(params.from);
    if (params.to) where.report.date.lte = new Date(params.to);
  }
  const platformSlug = params.platform?.trim().toLowerCase();
  if (platformSlug) where.account = { platform: { slug: platformSlug } };

  const links = await prisma.reportLink.findMany({
    where,
    select: {
      url: true,
      platform: true,
      account: { select: { id: true, handle: true, displayName: true, platform: { select: { slug: true } } } },
      report: { select: { date: true, employee: { select: { id: true, name: true } } } },
    },
  });

  const matchingRows = links
    .map((l) => ({ l, key: canonicalKey(l.url) }))
    .filter((x) => keyToPlatform.has(x.key));

  const totalPosts = matchingRows.length;
  const keyCounts = new Map<string, number>();
  for (const { key } of matchingRows) keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
  const uniquePosts = keyCounts.size;
  const duplicatePosts = totalPosts - uniquePosts;

  // Distinct channels with per-channel post counts (every row counts).
  const channelMap = new Map<string, SearchChannel>();
  for (const { l } of matchingRows) {
    const a = l.account;
    const existing = channelMap.get(a.id);
    if (existing) existing.postCount += 1;
    else
      channelMap.set(a.id, {
        accountId: a.id,
        handle: a.handle,
        displayName: a.displayName,
        platform: a.platform.slug,
        postCount: 1,
      });
  }
  const channels = [...channelMap.values()].sort((x, y) => y.postCount - x.postCount);

  // Posts: keep EVERY row, ungrouped, each tagged with how many rows share its key.
  const posts: SearchPost[] = matchingRows.map(({ l, key }) => ({
    canonicalKey: key,
    url: l.url as string,
    platform: l.account.platform.slug,
    account: { id: l.account.id, handle: l.account.handle, displayName: l.account.displayName },
    employee: { id: l.report.employee.id, name: l.report.employee.name },
    date: dateKey(l.report.date),
    dupCount: keyCounts.get(key) || 1,
  }));

  return {
    kind: "match",
    entity: { canonicalName: entity.canonicalName, type: entity.type, aliases: entity.aliases },
    totalPosts,
    uniquePosts,
    duplicatePosts,
    channelCount: channelMap.size,
    channels,
    posts,
    coverage: await entityCoverage(keys, keyToPlatform), // built in Task 5
  };
```

> The `coverage: await entityCoverage(...)` line references a function added in Task 5. Until then, temporarily keep the inline `coverage: { enriched: 0, notYetEnriched: 0, total: 0, byPlatform: {} }` placeholder on that line so the file compiles; Task 5 swaps it for the real call.

For now, use the placeholder:

```ts
    coverage: { enriched: 0, notYetEnriched: 0, total: 0, byPlatform: {} }, // built in Task 5
```

- [ ] **Step 4:** Run — the channels/posts, platform, and date-window tests MUST now pass (the Task 1 counting test still passes):

```bash
npm run test -w @dashmani/api -- link-search.test.ts
```

Expected output: `4 passed`.

- [ ] **Step 5:** Commit:

```bash
git add apps/api/src/services/link-search.service.ts apps/api/tests/link-search.test.ts
git commit -m "$(cat <<'EOF'
feat(link-search): distinct channels, ungrouped posts, dupCount + filters

Adds channelCount/channels (per-channel postCount), the full ungrouped
post list with per-post dupCount, and DB-side from/to/platform filters.
Every matching row is kept — grouping only counts, never collapses.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 23: Failing tests for disambiguation + no-match coverage explainer

Two short branches: multiple entities matching one query returns a disambiguation list (no counting), and a query that matches no entity returns global coverage so the admin sees *why* there are zero results.

Files:
- Modify `apps/api/tests/link-search.test.ts`

Steps:

- [ ] **Step 1:** Add these tests inside the `describe`:

```ts
  it("returns a disambiguation list when q matches multiple entities", async () => {
    await seed(); // both canonicalNames contain "Khan"
    const result = await searchLinksByEntity({ q: "khan" });
    expect(result.kind).toBe("disambiguation");
    if (result.kind !== "disambiguation") return;
    const names = result.matches.map((m) => m.canonicalName).sort();
    expect(names).toEqual(["Salman Khan", "Shah Rukh Khan"]);
  });

  it("returns no-match with global coverage when q matches no entity", async () => {
    await seed(); // 3 LinkContent rows, all status 'ok'
    const result = await searchLinksByEntity({ q: "nobody-here" });
    expect(result.kind).toBe("none");
    if (result.kind !== "none") return;
    expect(result.query).toBe("nobody-here");
    expect(result.coverage.total).toBe(3);
    expect(result.coverage.enriched).toBe(3);
    expect(result.coverage.notYetEnriched).toBe(0);
  });
```

- [ ] **Step 2:** Run — these MUST pass already (disambiguation + no-match branches were built in Task 2). This is a confirmation/regression-lock step, not a red step:

```bash
npm run test -w @dashmani/api -- link-search.test.ts
```

Expected output: `6 passed`. (If either fails, the Task 2 branch logic is wrong — fix the service, not the test.)

- [ ] **Step 3:** Commit:

```bash
git add apps/api/tests/link-search.test.ts
git commit -m "$(cat <<'EOF'
test(link-search): lock disambiguation + no-match coverage branches

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 24: Failing test for entity-scoped coverage (enriched / not-yet / byPlatform)

The matched result's `coverage` must report, for the matched entity's keys, how many are enriched (`status='ok'`), how many aren't, the total distinct keys, and a per-platform split — so the UI banner can say "31 of 47 enriched".

Files:
- Modify `apps/api/tests/link-search.test.ts`

Steps:

- [ ] **Step 1:** Add this test inside the `describe`:

```ts
  it("reports entity-scoped enrichment coverage with a per-platform split", async () => {
    await seed();
    const result = await searchLinksByEntity({ q: "salman" });
    expect(result.kind).toBe("match");
    if (result.kind !== "match") return;

    // Salman features in 2 distinct canonicalKeys: ig:CxYz123 + yt:dQw4w9WgXcQ.
    // Both LinkContent rows are status 'ok' → both enriched.
    expect(result.coverage.total).toBe(2);
    expect(result.coverage.enriched).toBe(2);
    expect(result.coverage.notYetEnriched).toBe(0);
    expect(result.coverage.byPlatform.instagram).toEqual({ enriched: 1, total: 1 });
    expect(result.coverage.byPlatform.youtube).toEqual({ enriched: 1, total: 1 });
  });
```

- [ ] **Step 2:** Run — MUST fail because `coverage` is still the `{enriched:0,...}` placeholder from Task 3:

```bash
npm run test -w @dashmani/api -- link-search.test.ts
```

Expected output: `6 passed`, `1 failed` (the new coverage test).

- [ ] **Step 3:** Add the `entityCoverage` helper to `apps/api/src/services/link-search.service.ts` (append after `globalCoverage`):

```ts
// Enrichment coverage scoped to ONE entity's set of canonicalKeys.
async function entityCoverage(
  keys: string[],
  keyToPlatform: Map<string, string>,
): Promise<SearchCoverage> {
  if (keys.length === 0) return { enriched: 0, notYetEnriched: 0, total: 0, byPlatform: {} };

  const okRows = await prisma.linkContent.findMany({
    where: { canonicalKey: { in: keys }, status: "ok" },
    select: { canonicalKey: true },
  });
  const okKeys = new Set(okRows.map((r) => r.canonicalKey));

  const byPlatform: Record<string, { enriched: number; total: number }> = {};
  for (const key of keys) {
    const p = keyToPlatform.get(key) || "unknown";
    if (!byPlatform[p]) byPlatform[p] = { enriched: 0, total: 0 };
    byPlatform[p].total += 1;
    if (okKeys.has(key)) byPlatform[p].enriched += 1;
  }

  return {
    enriched: okKeys.size,
    notYetEnriched: keys.length - okKeys.size,
    total: keys.length,
    byPlatform,
  };
}
```

- [ ] **Step 4:** Swap the placeholder in the match-result `return` to the real call (the `coverage:` line in the block from Task 3):

```ts
    coverage: await entityCoverage(keys, keyToPlatform),
```

- [ ] **Step 5:** Run — MUST pass now:

```bash
npm run test -w @dashmani/api -- link-search.test.ts
```

Expected output: `7 passed`.

- [ ] **Step 6:** Commit:

```bash
git add apps/api/src/services/link-search.service.ts apps/api/tests/link-search.test.ts
git commit -m "$(cat <<'EOF'
feat(link-search): entity-scoped enrichment coverage with per-platform split

coverage.{enriched,notYetEnriched,total,byPlatform} reports, for the matched
entity's distinct canonicalKeys, how many LinkContent rows are status='ok'
so the UI banner never implies the whole DB is indexed.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 25: Failing route test — `GET /admin/link-search` resolves (not captured by `/:reportId`)

The new route MUST live in the before-`/:reportId` block. Prove via supertest that `/admin/link-search` resolves to the search handler, not the `getReportById` handler, and returns the standard envelope.

Files:
- Modify `apps/api/tests/link-search.test.ts`

Steps:

- [ ] **Step 1:** At the top of `apps/api/tests/link-search.test.ts`, add the supertest + app + helper imports (next to the existing imports):

```ts
import request from "supertest";
import app from "../src/app";
import { createTestRole, createTestUser, generateToken } from "./helpers";
```

- [ ] **Step 2:** Add a second `describe` block (route layer) at the bottom of the file:

```ts
describe("GET /v1/admin/link-search (route)", () => {
  let token: string;

  beforeEach(async () => {
    await cleanLinkEntityTables();
    await createTestRole("Admin", [{ resource: "reports", action: "view", scope: "global" }]);
    const admin = await createTestUser({ roleNames: ["Admin"] });
    token = generateToken(admin.id, admin.email, ["Admin"]);
  });

  it("resolves the search handler — NOT captured by /:reportId", async () => {
    await seed();
    const res = await request(app)
      .get("/v1/admin/link-search?q=salman")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // If /:reportId had captured "link-search", getReportById would 404/throw on a
    // bad id — instead we get the structured search payload.
    expect(res.body.data.kind).toBe("match");
    expect(res.body.data.totalPosts).toBe(3);
    expect(res.body.data.uniquePosts).toBe(2);
    expect(res.body.data.channelCount).toBe(2);
  });

  it("400s when q is missing or empty", async () => {
    const res = await request(app)
      .get("/v1/admin/link-search")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("401s without a token", async () => {
    const res = await request(app).get("/v1/admin/link-search?q=salman");
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 3:** Run — MUST fail (route does not exist; `/admin/reports/:reportId` won't catch `/admin/link-search` since it's a different path prefix, so the search request 404s with no matching route):

```bash
npm run test -w @dashmani/api -- link-search.test.ts
```

Expected output: `7 passed`, `3 failed`.

- [ ] **Step 4:** Add the route to `apps/api/src/routes/admin-reports.routes.ts`. Insert it **inside the before-`/:reportId` block** — directly after the `top-youtube-links` route (ends at line 385) and **before** the `GET /admin/reports/:reportId` route (line 387). Match the lazy-import + `authenticate` + `requirePermission("reports","view")` + `success()` pattern of its neighbors exactly:

```ts
// GET /admin/link-search?q=&from=&to=&platform= — entity-based link search.
// MUST be before /:reportId (path prefix differs, but kept in this block per the
// established ordering convention for all admin search/aggregate routes).
router.get(
  "/admin/link-search",
  authenticate,
  requirePermission("reports", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { q, from, to, platform } = req.query as Record<string, string | undefined>;
      if (!q || !q.trim()) {
        return res.status(400).json({
          success: false,
          error: { code: "VALIDATION_ERROR", message: "q is required" },
        });
      }
      const { searchLinksByEntity } = await import("../services/link-search.service");
      const result = await searchLinksByEntity({ q, from, to, platform });
      return success(res, result);
    } catch (err) {
      next(err);
    }
  },
);
```

- [ ] **Step 5:** Run — MUST pass now:

```bash
npm run test -w @dashmani/api -- link-search.test.ts
```

Expected output: `10 passed`.

- [ ] **Step 6:** Commit:

```bash
git add apps/api/src/routes/admin-reports.routes.ts apps/api/tests/link-search.test.ts
git commit -m "$(cat <<'EOF'
feat(link-search): GET /admin/link-search route (before /:reportId)

Wires searchLinksByEntity behind authenticate + requirePermission(reports,view)
in the before-/:reportId block with the standard success() envelope. 400 on
missing q, 401 without a token. Route-ordering asserted in tests.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 26: Failing test for `GET /admin/entities` autocomplete endpoint

A lightweight typeahead endpoint for the UI: `?q=` returns up to 10 entities whose `canonicalName` or an alias matches, ordered by name. Same block, same auth.

Files:
- Modify `apps/api/src/services/link-search.service.ts` (add `searchEntities`)
- Modify `apps/api/tests/link-search.test.ts`
- Modify `apps/api/src/routes/admin-reports.routes.ts` (add `GET /admin/entities`)

Steps:

- [ ] **Step 1:** Add the service test inside the FIRST `describe("searchLinksByEntity")` block (it shares the same `seed`/cleanup):

```ts
  it("searchEntities returns matching entities by name or alias for typeahead", async () => {
    await seed();
    const byName = await searchEntities("salman");
    expect(byName.map((e) => e.canonicalName)).toEqual(["Salman Khan"]);

    const byAlias = await searchEntities("bhaijaan");
    expect(byAlias.map((e) => e.canonicalName)).toEqual(["Salman Khan"]);

    const broad = await searchEntities("khan");
    expect(broad.map((e) => e.canonicalName).sort()).toEqual(["Salman Khan", "Shah Rukh Khan"]);

    const empty = await searchEntities("");
    expect(empty).toEqual([]); // empty query → no suggestions
  });
```

- [ ] **Step 2:** Update the service import at the top of the test file to also pull `searchEntities`:

```ts
import { searchLinksByEntity, searchEntities } from "../src/services/link-search.service";
```

- [ ] **Step 3:** Add the route test inside the SECOND `describe("GET /v1/admin/link-search (route)")` block:

```ts
  it("GET /admin/entities returns the typeahead list (before /:reportId)", async () => {
    await seed();
    const res = await request(app)
      .get("/v1/admin/entities?q=khan")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.map((e: any) => e.canonicalName).sort()).toEqual([
      "Salman Khan",
      "Shah Rukh Khan",
    ]);
  });
```

- [ ] **Step 4:** Run — MUST fail (`searchEntities` not exported; `/admin/entities` route absent):

```bash
npm run test -w @dashmani/api -- link-search.test.ts
```

Expected output: `10 passed`, `2 failed`.

- [ ] **Step 5:** Add `searchEntities` to `apps/api/src/services/link-search.service.ts` (append, exported):

```ts
export interface EntitySuggestion {
  id: string;
  canonicalName: string;
  type: string;
  aliases: string[];
}

export async function searchEntities(q: string): Promise<EntitySuggestion[]> {
  const term = (q || "").trim();
  if (!term) return [];
  const rows = await prisma.entity.findMany({
    where: {
      OR: [
        { canonicalName: { contains: term, mode: "insensitive" } },
        { aliases: { hasSome: [term.toLowerCase()] } },
      ],
    },
    orderBy: { canonicalName: "asc" },
    take: 10,
    select: { id: true, canonicalName: true, type: true, aliases: true },
  });
  return rows;
}
```

- [ ] **Step 6:** Add the route to `apps/api/src/routes/admin-reports.routes.ts`, directly after the `GET /admin/link-search` route added in Task 6 and still **before** `GET /admin/reports/:reportId`:

```ts
// GET /admin/entities?q= — entity autocomplete/typeahead for the search UI.
router.get(
  "/admin/entities",
  authenticate,
  requirePermission("reports", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { q } = req.query as Record<string, string | undefined>;
      const { searchEntities } = await import("../services/link-search.service");
      const results = await searchEntities(q || "");
      return success(res, results);
    } catch (err) {
      next(err);
    }
  },
);
```

- [ ] **Step 7:** Run — MUST pass now:

```bash
npm run test -w @dashmani/api -- link-search.test.ts
```

Expected output: `12 passed`.

- [ ] **Step 8:** Commit:

```bash
git add apps/api/src/services/link-search.service.ts apps/api/src/routes/admin-reports.routes.ts apps/api/tests/link-search.test.ts
git commit -m "$(cat <<'EOF'
feat(link-search): GET /admin/entities typeahead endpoint

searchEntities(q) matches canonicalName or alias (case-insensitive),
capped at 10, for the search-page autocomplete. Same before-/:reportId
block + authenticate + requirePermission(reports,view).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 27: Verification gate — full type-check + targeted test run

Confirm the new service + routes type-check against the real Prisma client and that the new tests pass in isolation (the ~36 pre-existing analytics/content/task/team failures from `setup.ts` truncate gaps are NOT ours and are out of scope).

Files:
- None (verification only)

Steps:

- [ ] **Step 1:** Type-check the API package against the generated Prisma client:

```bash
npx tsc --noEmit -p /Users/tabish/Desktop/dashmani-platform/apps/api/tsconfig.json
```

Expected output: no errors (exit 0). If `prisma.entity` / `prisma.linkContent` / `prisma.linkContentEntity` are reported as missing, the Phase A `db:generate` has not run — stop and run `npm run db:generate` from the repo root, then re-check.

- [ ] **Step 2:** Run only this phase's test file and confirm all green:

```bash
npm run test -w @dashmani/api -- link-search.test.ts
```

Expected output: `Test Files 1 passed`, `Tests 12 passed`.

- [ ] **Step 3:** Sanity-confirm the route ordering by grepping that both new routes sit before the `:reportId` handler in the file:

```bash
grep -n "admin/link-search\|admin/entities\|admin/reports/:reportId" /Users/tabish/Desktop/dashmani-platform/apps/api/src/routes/admin-reports.routes.ts
```

Expected output: the `admin/link-search` and `admin/entities` line numbers are both **lower** than the `admin/reports/:reportId` line number.

- [ ] **Step 4:** No commit (verification only). If steps 1–3 all pass, Phase D is complete.

## Phase E — Stage 3 Search UI (internal portal)

### Task 28: Create the `use-link-search` SWR hook (the search query)

Files:
- Create `/Users/tabish/Desktop/dashmani-platform/apps/internal/src/lib/hooks/use-link-search.ts`

This hook follows the **exact** pattern of `apps/internal/src/lib/hooks/use-reports.ts`: it builds a `URLSearchParams` query, returns `useSWR(key, (url) => apiFetch(url))` (the **full** `{success,data}` envelope — pages unwrap `.data` themselves, matching `useLinksAnalytics`), passes `null` as the SWR key when there is no query so SWR doesn't fire on an empty box, and disables focus revalidation.

- [ ] **Step 1:** Write the file exactly as below:

```ts
import useSWR from "swr";
import { apiFetch } from "@/lib/api";

/**
 * Stage 3 search: GET /admin/link-search?q=...&from=...&to=...&platform=...
 * Returns the full {success,data} envelope (the page reads .data), matching the
 * convention in use-reports.ts. Passes `null` as the SWR key when q is empty so
 * SWR never fires on a blank box (no network, no flash of an empty result set).
 */
export function useLinkSearch(filters?: {
  q?: string;
  from?: string;
  to?: string;
  platform?: string;
}) {
  const q = filters?.q?.trim();
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (filters?.from) params.set("from", filters.from);
  if (filters?.to) params.set("to", filters.to);
  if (filters?.platform) params.set("platform", filters.platform);
  const key = q ? `/admin/link-search?${params.toString()}` : null;
  return useSWR(key, (url) => apiFetch(url), {
    revalidateOnFocus: false,
    dedupingInterval: 30_000,
  });
}
```

- [ ] **Step 2:** Type-check just this app to confirm the import path and SWR signature resolve. Do **not** run `npm run build` here (dev servers may be running — that poisons `.next`; see CLAUDE.md "build-over-dev .next corruption"). Run:

```bash
cd /Users/tabish/Desktop/dashmani-platform && npx tsc --noEmit -p apps/internal/tsconfig.json
```

Expected output: no output, exit code 0. (If you see `Cannot find module '@/lib/hooks/use-link-search'` errors from a not-yet-created consumer, ignore — that file doesn't exist yet; this task only adds the hook.)

- [ ] **Step 3:** Commit:

```bash
cd /Users/tabish/Desktop/dashmani-platform && git add apps/internal/src/lib/hooks/use-link-search.ts && git commit -m "feat(internal): add useLinkSearch SWR hook for GET /admin/link-search

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 29: Create the `use-entities` autocomplete hook

Files:
- Create `/Users/tabish/Desktop/dashmani-platform/apps/internal/src/lib/hooks/use-entities.ts`

This hook powers the search-box autocomplete (typeahead over `Entity.canonicalName` + aliases). It hits the same Stage-3 entity-listing endpoint produced in Phase D (`GET /admin/entities?q=<prefix>` — returns `{ data: Entity[] }`). It must passively no-op (key `null`) until the user has typed at least 2 characters, so we don't fire a request on every keystroke from char 1.

- [ ] **Step 1:** Write the file exactly as below:

```ts
import useSWR from "swr";
import { apiFetch } from "@/lib/api";

/**
 * Autocomplete over the Entity table (GET /admin/entities?q=<prefix>).
 * Returns the full {success,data} envelope; the page reads .data (Entity[]).
 * Fires only once the prefix is >= 2 chars to avoid a request per keystroke.
 */
export function useEntities(prefix?: string) {
  const p = prefix?.trim();
  const key = p && p.length >= 2 ? `/admin/entities?q=${encodeURIComponent(p)}` : null;
  return useSWR(key, (url) => apiFetch(url), {
    revalidateOnFocus: false,
    dedupingInterval: 30_000,
    keepPreviousData: true,
  });
}
```

- [ ] **Step 2:** Type-check:

```bash
cd /Users/tabish/Desktop/dashmani-platform && npx tsc --noEmit -p apps/internal/tsconfig.json
```

Expected output: no output, exit code 0.

- [ ] **Step 3:** Commit:

```bash
cd /Users/tabish/Desktop/dashmani-platform && git add apps/internal/src/lib/hooks/use-entities.ts && git commit -m "feat(internal): add useEntities autocomplete hook (GET /admin/entities)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 30: Build the Link Search page — header, search box with entity autocomplete, and persistent coverage banner

Files:
- Create `/Users/tabish/Desktop/dashmani-platform/apps/internal/src/app/reports/link-search/page.tsx`

This first slice builds the page scaffold: `usePageTitle("Link Search")`, a back-to-Reports link (mirrors `apps/internal/src/app/reports/links/page.tsx` lines 95–99), a debounced search box wired to `useLinkSearch`, an entity-autocomplete dropdown wired to `useEntities`, and the **persistent coverage banner** that reads `coverage.{enriched,total}` off the result envelope. The banner text is honest about IG/FB being dark (`SUPPORTED_INSIGHT_PLATFORMS = ["youtube"]` per spec §8.3). Uses the cream/ink/`v3-card` tokens already on the Reports pages. The summary strip + tables come in Task 4 — this task ends with a placeholder where they will mount, so the page compiles and renders standalone.

- [ ] **Step 1:** Write the file exactly as below:

```tsx
"use client";
import { useState, useEffect, useRef, useMemo } from "react";
import Link from "next/link";
import { ArrowLeft, Search, Info, X } from "lucide-react";
import { useLinkSearch } from "@/lib/hooks/use-link-search";
import { useEntities } from "@/lib/hooks/use-entities";
import { usePageTitle } from "@/lib/hooks/use-page-title";

interface EntityLite {
  id: string;
  canonicalName: string;
  type: string;
  aliases: string[];
}

function fmtNum(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-IN");
}

export default function LinkSearchPage() {
  usePageTitle("Link Search");

  // `input` is what the user is typing (drives autocomplete); `query` is the
  // committed search term (drives the results fetch). Debounce input → query so
  // we don't fire a search on every keystroke.
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [showSuggest, setShowSuggest] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // Debounce: 350ms after the last keystroke, commit input → query.
  useEffect(() => {
    const t = setTimeout(() => setQuery(input.trim()), 350);
    return () => clearTimeout(t);
  }, [input]);

  // Close the suggestion dropdown on an outside click.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setShowSuggest(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const { data: searchData, isLoading } = useLinkSearch({ q: query });
  const { data: suggestData } = useEntities(input);

  const result = (searchData as any)?.data;
  const suggestions: EntityLite[] = useMemo(() => (suggestData as any)?.data ?? [], [suggestData]);

  const coverage = result?.coverage as
    | { enriched: number; notYetEnriched: number; total: number }
    | undefined;

  function pick(name: string) {
    setInput(name);
    setQuery(name);
    setShowSuggest(false);
  }

  return (
    <div className="space-y-6 pop-in">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/reports" className="flex items-center gap-1 text-sm text-ink-4 hover:text-ink transition-colors">
          <ArrowLeft className="h-4 w-4" /> Reports
        </Link>
      </div>

      <div>
        <h1 className="font-display text-2xl font-semibold text-ink">Link Search</h1>
        <p className="text-sm text-ink-4 mt-0.5">
          Find every post that features a person or topic, across all submitted links.
        </p>
      </div>

      {/* Search box + entity autocomplete */}
      <div ref={boxRef} className="relative max-w-xl">
        <div className="flex items-center gap-2 v3-card-sm px-3 h-12">
          <Search className="h-4 w-4 text-ink-4 shrink-0" />
          <input
            type="text"
            value={input}
            onChange={(e) => { setInput(e.target.value); setShowSuggest(true); }}
            onFocus={() => setShowSuggest(true)}
            placeholder="Search a person or topic (e.g. Salman Khan)…"
            className="flex-1 bg-transparent text-sm text-ink placeholder:text-ink-4 focus:outline-none"
            aria-label="Search links by person or topic"
          />
          {input && (
            <button
              onClick={() => { setInput(""); setQuery(""); setShowSuggest(false); }}
              className="p-1 text-ink-4 hover:text-ink"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Autocomplete dropdown */}
        {showSuggest && suggestions.length > 0 && (
          <div className="absolute z-30 mt-1 w-full v3-card-sm py-1 max-h-64 overflow-y-auto shadow-hard">
            {suggestions.map((e) => (
              <button
                key={e.id}
                onClick={() => pick(e.canonicalName)}
                className="w-full text-left px-3 py-2 hover:bg-muted transition-colors"
              >
                <span className="text-sm font-medium text-ink">{e.canonicalName}</span>
                <span className="ml-2 text-[10px] uppercase tracking-wide text-ink-4">{e.type}</span>
                {e.aliases?.length > 0 && (
                  <span className="block text-[11px] text-ink-4 truncate">{e.aliases.join(", ")}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Persistent coverage banner — the count must never read as the whole DB. */}
      <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
        <Info className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
        <p className="text-xs text-amber-800 leading-relaxed">
          {coverage
            ? <>Searching <span className="font-semibold">{fmtNum(coverage.enriched)}</span> of <span className="font-semibold">{fmtNum(coverage.total)}</span> enriched links.</>
            : <>Only YouTube links are enriched so far.</>}
          {" "}Instagram and Facebook enrichment is pending the Meta API — those links are not yet searchable.
        </p>
      </div>

      {/* Results mount here in Task 4 */}
      {query && (
        <div data-testid="results-region">
          {isLoading ? (
            <p className="text-sm text-ink-4">Searching…</p>
          ) : !result ? (
            <p className="text-sm text-ink-4">No results for &ldquo;{query}&rdquo;.</p>
          ) : (
            <p className="text-sm text-ink-4">Results render here (Task 4).</p>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2:** Type-check:

```bash
cd /Users/tabish/Desktop/dashmani-platform && npx tsc --noEmit -p apps/internal/tsconfig.json
```

Expected output: no output, exit code 0.

- [ ] **Step 3:** Commit:

```bash
cd /Users/tabish/Desktop/dashmani-platform && git add apps/internal/src/app/reports/link-search/page.tsx && git commit -m "feat(internal): scaffold /reports/link-search page (search box, autocomplete, coverage banner)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 31: Add the summary strip, channel breakdown table, and grouped/badged results list

Files:
- Modify `/Users/tabish/Desktop/dashmani-platform/apps/internal/src/app/reports/link-search/page.tsx` (replace the "Results mount here in Task 4" block; add render helpers)

This task fills in the real results UI per spec §7: a **summary strip** (Total / Unique / Duplicates / Channels), a **channel breakdown table** (`channels[]`), and a **results list** where each post row shows its `dupCount` badge so duplicates are visibly **grouped and labelled, never collapsed** (the user's hard requirement from spec §2/§7). Loading placeholders are gated on `isLoading && !result` per the CLAUDE.md jobs-portal rule (never bare `isLoading`), and the page renders `formatStatus`-free since these are raw counts. Stat-card markup mirrors `apps/internal/src/app/reports/links/page.tsx` lines 117–157 (`v3-card-sm`, `font-display text-2xl`, `text-ink-4` labels).

- [ ] **Step 1:** Replace this exact block:

```tsx
      {/* Results mount here in Task 4 */}
      {query && (
        <div data-testid="results-region">
          {isLoading ? (
            <p className="text-sm text-ink-4">Searching…</p>
          ) : !result ? (
            <p className="text-sm text-ink-4">No results for &ldquo;{query}&rdquo;.</p>
          ) : (
            <p className="text-sm text-ink-4">Results render here (Task 4).</p>
          )}
        </div>
      )}
```

with:

```tsx
      {/* Results */}
      {query && (
        <div data-testid="results-region" className="space-y-6">
          {isLoading && !result ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 animate-pulse">
              {[...Array(4)].map((_, i) => <div key={i} className="h-20 v3-card-sm" />)}
            </div>
          ) : !result || !result.entity ? (
            <div className="v3-card p-6 text-center">
              <p className="text-sm text-ink">No matches for &ldquo;{query}&rdquo;.</p>
              <p className="text-xs text-ink-4 mt-1">
                A 0 here can also mean the post exists but its link isn&rsquo;t enriched yet — see the coverage note above.
              </p>
            </div>
          ) : (
            <>
              {/* Entity heading */}
              <div className="flex items-baseline gap-3 flex-wrap">
                <h2 className="font-display text-xl font-semibold text-ink">{result.entity.canonicalName}</h2>
                <span className="text-[10px] uppercase tracking-wide text-ink-4">{result.entity.type}</span>
                {result.entity.aliases?.length > 0 && (
                  <span className="text-xs text-ink-4">aka {result.entity.aliases.join(", ")}</span>
                )}
              </div>

              {/* Summary strip: Total / Unique / Duplicates / Channels */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: "Total Posts", value: result.totalPosts, tone: "text-ink" },
                  { label: "Unique Posts", value: result.uniquePosts, tone: "text-indigo" },
                  { label: "Duplicates", value: result.duplicatePosts, tone: "text-terra" },
                  { label: "Channels", value: result.channelCount, tone: "text-sage" },
                ].map((s) => (
                  <div key={s.label} className="v3-card-sm p-4 space-y-1">
                    <p className={`font-display text-2xl font-semibold leading-none pt-1 ${s.tone}`}>{fmtNum(s.value)}</p>
                    <p className="text-xs text-ink-4">{s.label}</p>
                  </div>
                ))}
              </div>

              {/* Channel breakdown */}
              <div className="v3-card p-5 space-y-3">
                <p className="font-semibold text-ink">Channel Breakdown</p>
                {(!result.channels || result.channels.length === 0) ? (
                  <p className="text-xs text-ink-4">No channels.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs text-ink-4 border-b border-ink/10">
                          <th className="py-2 pr-3 font-medium">Channel</th>
                          <th className="py-2 pr-3 font-medium">Platform</th>
                          <th className="py-2 pr-3 font-medium text-right">Posts</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.channels.map((c: any) => (
                          <tr key={c.accountId} className="border-b border-ink/5 last:border-0">
                            <td className="py-2 pr-3">
                              <span className="font-medium text-ink">{c.displayName || c.handle}</span>
                              {c.handle && c.displayName && <span className="ml-1.5 text-xs text-ink-4">{c.handle}</span>}
                            </td>
                            <td className="py-2 pr-3 text-ink-4 capitalize">{c.platform}</td>
                            <td className="py-2 pr-3 text-right tabular-nums text-ink">{fmtNum(c.postCount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Results list — duplicates grouped + badged, never collapsed */}
              <div className="v3-card p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="font-semibold text-ink">Posts</p>
                  <p className="text-xs text-ink-4">{fmtNum(result.totalPosts)} rows · {fmtNum(result.uniquePosts)} unique</p>
                </div>
                {(!result.posts || result.posts.length === 0) ? (
                  <p className="text-xs text-ink-4">No posts.</p>
                ) : (
                  <div className="space-y-2">
                    {result.posts.map((p: any) => (
                      <div key={p.canonicalKey + (p.url || "")} className="flex items-center gap-3 rounded-xl border border-ink/8 px-3 py-2.5 hover:bg-muted/50 transition-colors">
                        <div className="min-w-0 flex-1">
                          <a
                            href={p.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm text-indigo hover:underline truncate block"
                          >
                            {p.url}
                          </a>
                          <p className="text-xs text-ink-4 mt-0.5 truncate">
                            <span className="capitalize">{p.platform}</span>
                            {p.account ? ` · ${p.account}` : ""}
                            {p.employee ? ` · ${p.employee}` : ""}
                            {p.date ? ` · ${new Date(p.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}` : ""}
                          </p>
                        </div>
                        {p.dupCount > 1 && (
                          <span className="shrink-0 h-6 px-2.5 rounded-full bg-terra/12 text-terra text-[11px] font-semibold grid place-items-center tabular-nums">
                            ×{p.dupCount}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
```

- [ ] **Step 2:** Type-check:

```bash
cd /Users/tabish/Desktop/dashmani-platform && npx tsc --noEmit -p apps/internal/tsconfig.json
```

Expected output: no output, exit code 0.

- [ ] **Step 3:** Commit:

```bash
cd /Users/tabish/Desktop/dashmani-platform && git add apps/internal/src/app/reports/link-search/page.tsx && git commit -m "feat(internal): link-search summary strip, channel table, grouped+badged results

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 32: Add a `loading.tsx` for the link-search route

Files:
- Create `/Users/tabish/Desktop/dashmani-platform/apps/internal/src/app/reports/link-search/loading.tsx`

Every Reports route folder ships a `loading.tsx` skeleton (see `apps/internal/src/app/reports/loading.tsx`). Add one for this route so the initial route transition shows a skeleton, not a blank frame.

- [ ] **Step 1:** Write the file exactly as below:

```tsx
export default function Loading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-8 w-40 bg-rule rounded-xl" />
      <div className="h-12 max-w-xl bg-rule rounded-xl" />
      <div className="h-14 bg-rule rounded-xl" />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[...Array(4)].map((_, i) => <div key={i} className="h-20 bg-rule rounded-xl" />)}
      </div>
    </div>
  );
}
```

- [ ] **Step 2:** Type-check:

```bash
cd /Users/tabish/Desktop/dashmani-platform && npx tsc --noEmit -p apps/internal/tsconfig.json
```

Expected output: no output, exit code 0.

- [ ] **Step 3:** Commit:

```bash
cd /Users/tabish/Desktop/dashmani-platform && git add apps/internal/src/app/reports/link-search/loading.tsx && git commit -m "feat(internal): add loading skeleton for /reports/link-search

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 33: Add the sidebar nav entry under the Analytics section

Files:
- Modify `/Users/tabish/Desktop/dashmani-platform/apps/internal/src/components/sidebar.tsx` (the `primaryNav` array, lines 16–38; the lucide-react import block, lines 5–11)

The sidebar groups items by a `group` field; a group header renders only on the first item whose `group` differs from the previous (see `NavItem` `showGroupLabel` logic, sidebar lines 89–96). The existing items already carry `group: "Analytics"` (Attendance, line 27) and `group: "Tools"` (AI Assistant, line 36). Per the phase brief, place Link Search under **Analytics** — directly after the existing `/reports` ("Link Reports") item so it reads as a sub-feature of reporting. `/reports/link-search` is a child path of `/reports`, but the `NavItem` active check (`pathname.startsWith(href + "/")`) would light up *both* "Link Reports" and "Link Search" on the same path — that's acceptable and matches how the existing nav already treats child routes; no override needed. Use the `Search` icon from lucide-react.

- [ ] **Step 1:** Add `Search` to the lucide-react import. Replace this exact line (sidebar line 10):

```tsx
  Menu, X as CloseIcon, CalendarOff, ClipboardList,
```

with:

```tsx
  Menu, X as CloseIcon, CalendarOff, ClipboardList, Search,
```

- [ ] **Step 2:** Add the nav entry. Replace this exact line (sidebar line 31):

```tsx
  { href: "/reports",       label: "Link Reports",     icon: FileText,        group: null },
```

with:

```tsx
  { href: "/reports",       label: "Link Reports",     icon: FileText,        group: null },
  { href: "/reports/link-search", label: "Link Search", icon: Search,        group: null },
```

(Both stay `group: null` so they sit under the single "Analytics" header opened by `/attendance` — no new header, no regrouping of existing items.)

- [ ] **Step 3:** Type-check:

```bash
cd /Users/tabish/Desktop/dashmani-platform && npx tsc --noEmit -p apps/internal/tsconfig.json
```

Expected output: no output, exit code 0.

- [ ] **Step 4:** Commit:

```bash
cd /Users/tabish/Desktop/dashmani-platform && git add apps/internal/src/components/sidebar.tsx && git commit -m "feat(internal): add Link Search entry to sidebar nav

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 34: Verification gate — full type-check + full build (NOT while dev servers run)

Files: none (verification only)

The login pages import shared components that only fail under a **full** `npm run build`, per CLAUDE.md — so a per-app `tsc` pass is necessary but not sufficient. This task runs the full gate.

- [ ] **Step 1:** **Confirm no dev servers are running first** — `npm run build` while `npm run dev` is live poisons the `.next` cache (CLAUDE.md "build-over-dev .next corruption": symptoms are 500s / "Cannot find module './590.js'"). Check and kill any dev processes on the app ports:

```bash
lsof -ti:4000,3000,3001,3002,3003 | xargs kill -9 2>/dev/null; echo "ports clear"
```

Expected output: `ports clear` (with or without prior PIDs killed).

- [ ] **Step 2:** Full type-check across the three packages this phase touches:

```bash
cd /Users/tabish/Desktop/dashmani-platform && npx tsc --noEmit -p apps/internal/tsconfig.json && npx tsc --noEmit -p packages/shared/tsconfig.json && npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected output: no output, exit code 0 from all three.

- [ ] **Step 3:** Full build of **all** apps (catches cross-app shared-import breakage):

```bash
cd /Users/tabish/Desktop/dashmani-platform && npm run build
```

Expected output: Turbo runs every `@dashmani/*#build`, all show `cache miss, executing` or `cache hit`, and the run ends with `Tasks: N successful, N total` and no `ERROR` lines. The internal app's build log should list the new route, e.g. `○ /reports/link-search` in the route table. If the build fails with `Module not found: Can't resolve '@/lib/hooks/use-link-search'` or `'@/lib/hooks/use-entities'`, the hooks from Tasks 1–2 were not committed — re-stage and commit them.

- [ ] **Step 4:** No commit (verification only). If anything fails, fix and re-run before proceeding.

---

### Task 35: Manual smoke test — confirm the search UI renders end to end

Files: none (manual verification)

This confirms the page mounts, the coverage banner is always present, and a real search renders the summary strip + channel table + grouped results. This assumes Phases A–D shipped the `Entity`/`LinkContent` tables, the extraction pipeline, the `GET /admin/link-search` + `GET /admin/entities` endpoints, and that the local DB has at least one extracted YouTube entity to search (run the Stage-1/Stage-2 backfill scripts in dry-run-then-`--apply` per their own phases first if the DB is empty).

- [ ] **Step 1:** Start the API and the internal portal (background, so the terminal stays usable):

```bash
cd /Users/tabish/Desktop/dashmani-platform && npm run dev -w @dashmani/api &
cd /Users/tabish/Desktop/dashmani-platform && npm run dev -w @dashmani/internal &
```

- [ ] **Step 2:** Wait for the internal portal to answer (poll until 200/307, never a foreground `sleep`):

```bash
until curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/login | grep -q "200\|307"; do :; done; echo "internal up"
```

Expected output: `internal up`.

- [ ] **Step 3:** Confirm the API search endpoint is mounted (it returns the `{success}` envelope; a 401 without a token still proves the route exists and is *not* swallowed by `/:reportId`):

```bash
curl -s "http://localhost:4000/v1/admin/link-search?q=test" | head -c 200
```

Expected output: a JSON envelope — either `{"success":false,"error":{...}}` (auth required, route exists) or, if you pass a token, `{"success":true,"data":{...}}`. It must **not** be an HTML page or a "report not found" error (which would mean Express matched `/:reportId` instead — a route-ordering bug to flag back to the API phase).

- [ ] **Step 4:** In a browser, log in to the internal portal (`http://localhost:3000/login`, `admin@digitalsukoon.com` / `Admin@123456`), then open **Reports → Link Search** from the sidebar (under the Analytics group) or go directly to `http://localhost:3000/reports/link-search`. Confirm by eye:
   - The page title tab reads `Link Search — Dashmani Portal`.
   - The amber **coverage banner** is visible immediately, before any search ("…Instagram and Facebook enrichment is pending the Meta API…").
   - Typing 2+ chars of a known entity (e.g. start typing a name present in your seeded data) shows the autocomplete dropdown; clicking a suggestion fills the box and runs the search.
   - On a search with results: the **summary strip** shows Total / Unique / Duplicates / Channels, the **Channel Breakdown** table lists channels with post counts, and the **Posts** list renders rows with a `×N` badge on any duplicated post (duplicates shown, not collapsed).
   - On a no-match query: the empty state explains a 0 may mean "not yet enriched", and the coverage banner still shows.

- [ ] **Step 5:** Tear down the background dev servers so a later `npm run build` is never run over a live dev cache:

```bash
lsof -ti:4000,3000 | xargs kill -9 2>/dev/null; echo "dev stopped"
```

Expected output: `dev stopped`.

- [ ] **Step 6:** No commit (manual verification only).

---

# Safety Corrections (full list — fold each into the corresponding task)

### Phase A — Schema — 6 findings

- **[HIGH]** HARD ERROR — the command aborts, killing the entire 'prove the diff is additive' safety gate. Verified by running it: from the repo root, Prisma 5.14 cannot resolve the RELATIVE path passed to `--from-schema-datasource` and prints `Error: Could not load --from-schema-datasource from provided path 'packages/db/prisma/schema.prisma': file or directory not found` even though the file exists. (`migrate diff` resolves these schema paths differently from `--schema`.) Because step 3's hard gate pipes this same failing command into `grep ... || echo 'ADDITIVE-ONLY...'`, the grep gets EMPTY input, the `||` branch fires, and it prints the reassuring `ADDITIVE-ONLY: no drops` line WHILE THE DIFF ACTUALLY ERRORED AND PROVED NOTHING. A literal implementer sees the green message and proceeds to `db:push` with zero real verification — the exact opposite of the intended safety check.
  - **Where:** Task 3, step 2 and step 3: `npx prisma migrate diff --from-schema-datasource packages/db/prisma/schema.prisma --to-schema-datamodel packages/db/prisma/schema.prisma --script`
  - **Fix (apply before/while implementing):** Run the diff from inside `packages/db` (so the relative `prisma/schema.prisma` resolves and `packages/db/.env` supplies DATABASE_URL), OR use absolute paths from root. Verified working forms: `cd packages/db && npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script`. ALSO add `set -o pipefail` (or capture the SQL to a file first and check `$?`) before the `| grep ... || echo ADDITIVE` gate so a diff that ERRORS can never masquerade as 'additive-only'. Better still, append `--exit-code` and assert the process exit status explicitly rather than trusting an `||` echo.

- **[HIGH]** FALSE-NEGATIVE BLIND SPOT. The 'existing table' allowlist is hardcoded to only 6 of the schema's ~50 tables. The `DROP (TABLE|COLUMN)` clause does catch any destructive drop globally (verified), but an unintended *non-drop* mutation of an existing table NOT in the 6-name list — e.g. `ALTER TABLE "content_posts" ADD COLUMN ...` or `ALTER TABLE "tasks" ...` produced if the implementer accidentally adds a back-relation field to an existing model — will slip straight through the gate and report 'ADDITIVE-ONLY'. That is precisely the regression class the user's hard constraint ('no ALTER/DROP on existing tables') is meant to block.
  - **Where:** Task 3, step 3: grep gate `grep -iE 'DROP (TABLE|COLUMN)|ALTER TABLE "(report_links|link_metrics|users|report_drafts|social_accounts|daily_reports)"'`
  - **Fix (apply before/while implementing):** Make the gate detect ANY `ALTER TABLE` on a table that is NOT one of the three new tables, instead of allow-listing a partial set of old ones. Concretely: `grep -iE '^(DROP|ALTER) TABLE' diff.sql | grep -viE 'ALTER TABLE "link_content_entities" ADD CONSTRAINT' | grep -viE '"(entities|link_content|link_content_entities)"'` — anything that survives both inverse greps is a touch on an existing object and must STOP the run. (The only legitimate ALTER is the two FK ADD CONSTRAINTs on the brand-new `link_content_entities` table — verified that Prisma emits FKs as `ALTER TABLE "<table>" ADD CONSTRAINT ... FOREIGN KEY ...`.)

- **[MEDIUM]** Two breakages, both cosmetic-but-misleading (could make a successful push look failed and trigger a needless 'revert'). (1) The container image is `postgres:16-alpine` (verified in docker-compose.yml), NOT `postgres:16` — `docker ps -qf 'ancestor=postgres:16'` will NOT match the alpine tag, so the `$(...)` returns empty and the command fails with a docker-exec usage error. (2) psql `\dt` does not take a pipe-delimited multi-pattern argument; `\dt entities|link_content|...` is parsed by the shell as a pipe to a (nonexistent) `link_content` command, not by psql. So even with the right container the listing won't work as written.
  - **Where:** Task 3, step 5: `docker exec -i $(docker ps -qf "ancestor=postgres:16" ...) psql -U user -d dashmani -c "\dt entities|link_content|link_content_entities"`
  - **Fix (apply before/while implementing):** Target the known container name directly (it is fixed in docker-compose: `container_name: dashmani-db`): `docker exec -i dashmani-db psql -U user -d dashmani -c '\dt' -c '\d link_content'`. Filter the `\dt` output with a following `grep -E 'entities|link_content'` in the shell rather than inside psql. This is purely a verification command — it cannot corrupt data — but a literal implementer hitting the empty-`ancestor` error may wrongly conclude the push failed.

- **[MEDIUM]** `--from-schema-datasource` diffs against the LIVE local DB (verified: when the DB is unreachable the command returns `P1001 Can't reach database server`). The plan's step 1 only greps `docker ps` for a postgres line; it does not confirm the schema is already in sync. If the local dev DB has drifted (e.g. a previously-pushed experimental column, or it was never seeded/pushed for this branch), the 'additive' diff will legitimately contain CREATE/ALTER lines for pre-existing drift that have nothing to do with this feature — confusing the gate and possibly tripping it. Conversely, if someone runs the diff with `--from-empty` by mistake, it emits CREATE TABLE for ALL 50 tables and the gate's 6-name ALTER check passes trivially while proving nothing about additivity.
  - **Where:** Task 3, step 2 (`--from-schema-datasource`) — DB-state precondition
  - **Fix (apply before/while implementing):** Before the additive diff, assert the local DB is already in sync with HEAD's schema: run `cd packages/db && npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code` on the PRE-edit schema (git stash or compare against `origin/main`) and require exit code 0 (empty diff). Only then apply Task 1's edit and re-diff — now any non-empty output is attributable solely to the three new tables. Document that the diff must be `datasource→datamodel` against the SAME post-edit schema, never `--from-empty`.

- **[LOW]** Brittle expected-output assertions that can cause a literal implementer to falsely declare failure on a successful run. Prisma 5.14's `prisma generate` success line includes version and path (`✔ Generated Prisma Client (v5.x.x) to ./node_modules/...`), and under Turbo (`npm run db:generate` -> `turbo db:generate`) the line is prefixed with the package/task name and may be cached/suppressed (`cache hit, replaying logs` shows nothing). The Task 2 step 3 `tsx -e` delegate probe also instantiates a real `PrismaClient` which can attempt env/engine resolution; it is heavier than needed and can fail for reasons unrelated to generation success.
  - **Where:** Task 2, step 2 expected output: `✔ Generated Prisma Client` (and step 3's `npx tsx -e ...` delegate check)
  - **Fix (apply before/while implementing):** Don't assert an exact substring. Treat `db:generate` success as exit code 0 and verify generation by checking the generated types exist on disk (`ls node_modules/.prisma/client/index.d.ts` and `grep -q 'LinkContentEntity' node_modules/.prisma/client/index.d.ts`) rather than parsing stdout or instantiating a client. If keeping the tsx probe, gate it on the type-level (`Prisma.LinkContentDelegate`) instead of `new PrismaClient()` to avoid an engine/DB dependency in what is supposed to be a no-DB compile check.

- **[LOW]** No regression found here — this part is safe and matches repo conventions. Verified: schema ends at line 1371 on LinkMetric's closing brace (append target is correct); `@@unique([canonicalName])`, `String[]`, `@db.Text`, `@map`, `onDelete: Cascade` all already used elsewhere; the FK ON UPDATE CASCADE default matches every existing relation; datasource is plain `postgresql` with NO `relationMode` so real FKs are created (consistent with the rest of the schema). Critically, the three new relation fields (`Entity.links`, `LinkContent.entities`, `LinkContentEntity.content/entity`) reference ONLY each other — ZERO back-relation is added to any existing model, and ReportLink/LinkMetric are untouched (join-by-canonicalKey-on-read preserved). The `@map` additions for the two timestamps are a correct convention match (the spec omitted them). The existing metrics pipeline, cron, and SUPPORTED_INSIGHT_PLATFORMS switch are not referenced by this phase at all.
  - **Where:** Task 1: the three new models + `@map("extracted_at")` / `@map("fetched_at")` additions and relation topology
  - **Fix (apply before/while implementing):** No change to the model definitions. Keep them exactly as written. (The risk in this phase is entirely in the verification commands of Tasks 2-3, not the schema text.)


### Phase B — Enrich — 9 findings

- **[MEDIUM]** REGRESSION (build break, all insights cron dies). The plan tells a literal implementer to REPLACE the cron import block (cited as lines 1–5) with a new block that imports `getSupportedSlugs, getProvider`. But the actual file (apps/api/src/cron/social-insights.cron.ts lines 1–5) imports BOTH `getSupportedSlugs` AND `getProvider` from `../services/social-insights`, plus `import { prisma } from "@dashmani/db"`, `import { extractYouTubeVideoId } from "@dashmani/shared"`, `import type { InsightTarget }`, and `import { youTubeQuotaExceeded }`. The plan's replacement block keeps all of those AND adds `canonicalKey` to the shared import and adds the `upsertLinkContent` import — which is correct. The danger is the WORD 'Replace lines 1–5': the real import block is exactly 5 lines and the plan's replacement preserves every existing symbol, so this specific edit is actually safe. No fix needed beyond confirming the implementer pattern-matches on symbols (`getSupportedSlugs`, `youTubeQuotaExceeded`, `extractYouTubeVideoId`) rather than blindly trusting line numbers, since several other line-number citations in this phase are WRONG (see other findings).
  - **Where:** Task 4, Step 1 — cron import block edit
  - **Fix (apply before/while implementing):** Change the instruction from 'replace lines 1–5' to 'add `canonicalKey` to the existing `@dashmani/shared` import and add `import { upsertLinkContent } from "../services/link-content.service";` — do NOT remove `getSupportedSlugs`, `getProvider`, `youTubeQuotaExceeded`, `extractYouTubeVideoId`, `prisma`, or the `InsightTarget` type import, all of which the existing loop depends on.' This makes the edit additive and immune to the stale line numbers.

- **[MEDIUM]** REGRESSION RISK from literal line edits hitting the wrong code. The plan cites: interfaces 'lines 7–21' / 'replace lines 13–16'; fetch URL 'line 58'; 'statsById build lines 92–95'; 'per-target mapping lines 97–112'; result mapping 'lines 102–111'. Verified actual file: `YouTubeStatistics` is lines 7–11; `YouTubeItem` is lines 13–16 (only `id` + `statistics?`); the fetch URL `part=statistics` is on line 58 (correct); the `statsById` map build is lines 91–95 (off by one); the per-target `for (const t of batch)` block is lines 97–112 (correct); the metric mapping is lines 102–111 (correct). The 'replace lines 13–16' for YouTubeItem is correct, but 'interfaces lines 7–21' is misleading (7–21 spans Statistics+Item+ApiResponse+the `youTubeQuotaExceeded` export). A literal implementer replacing 7–21 wholesale could clobber `YouTubeApiResponse` (used by the error-handling block lines 64–80) and the `export let youTubeQuotaExceeded` (imported by the cron) — breaking quota handling and the cron import.
  - **Where:** Task 2, Steps 3–6 — youtube.provider.ts line-number citations are all wrong
  - **Fix (apply before/while implementing):** Drop the 'interfaces lines 7–21' framing. Specify exactly: (a) ADD a new `YouTubeSnippet` interface, (b) add `snippet?: YouTubeSnippet;` to the existing `YouTubeItem` interface (do not touch `YouTubeApiResponse` or the `export let youTubeQuotaExceeded` line), (c) change only the `part=statistics` substring on the fetch URL to `part=statistics,snippet`, (d) replace the `statsById` map + per-target loop with the combined `itemsById` version. Tell the implementer to match on code text, not line numbers.

- **[LOW]** TEST FLAKE / FALSE PASS, not a prod regression. vitest.config.ts has `setupFiles: ["./tests/setup.ts"]`, so its `beforeEach` runs for EVERY test file in the run — including link-content.test.ts — regardless of whether the file imports setup. The plan's claim 'setup.ts does NOT truncate the new tables so this test cleans link_content itself' is half right: the global hook fires too, truncating the legacy table list (which does NOT contain link_content/entities/link_content_entities, confirmed). So both beforeEach hooks run. Vitest runs setupFile hooks before the test-file's own hooks, so order is: global TRUNCATE(legacy) → file TRUNCATE(new tables) → test. That happens to be harmless because the two table sets are disjoint and the new tables have no FK into the legacy ones. BUT: the test's `beforeEach` issues `TRUNCATE ... entities CASCADE` where `entities` is the NEW table — if a future/parallel test or Phase A leaves the `entities` name colliding, or if the truncate runs against a DB where Phase A's tables don't yet exist, the whole api test RUN aborts on the first beforeEach (relation does not exist), taking unrelated suites with it.
  - **Where:** Task 3, link-content.test.ts — global setupFiles beforeEach truncates a table list that omits the new tables AND runs in addition to the test's own beforeEach
  - **Fix (apply before/while implementing):** Add a hard precondition to Task 3 step 1: the test's `beforeEach`/`afterAll` TRUNCATE must be guarded so a missing table can't abort the run — e.g. wrap in try/catch or assert Phase A migrations are applied (`SELECT to_regclass('public.link_content')` non-null) at the top, skipping with a clear message otherwise. Also note in the plan that this runs IN ADDITION TO the global setup.ts beforeEach (not instead of it), so the implementer doesn't assume isolation.

- **[LOW]** FALSE VERIFICATION. The command `npx tsc --noEmit scripts/enrich-link-content.ts --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --noEmit` lists `--noEmit` twice and type-checks a single file in isolation. Because the script deep-imports `../apps/api/src/services/social-insights` and `../apps/api/src/services/link-content.service` (which transitively pull in @dashmani/db, @prisma/client, @anthropic via the registry's instagram/facebook providers), an ad-hoc single-file tsc with nodenext resolution and no tsconfig/paths will almost certainly EITHER error on unresolved workspace imports OR silently 'pass' under --skipLibCheck while not actually validating the imported graph. Either way it is not a trustworthy gate, and the plan even hedges ('if a path-resolution warning appears... the authoritative check is the dry-run'). A green-looking but meaningless check invites shipping a script that doesn't compile.
  - **Where:** Task 5, Step 2 — malformed tsc invocation for the script
  - **Fix (apply before/while implementing):** Replace step 2 with a real check: run the dry-run under tsx (step 3) as the authoritative compile+run check, and additionally `npx tsc --noEmit -p apps/api/tsconfig.json` is already covered by the service/provider tasks. Do not present an isolated single-file tsc as a gate. If a static check of the script is wanted, add it to a tsconfig include and run the project-level tsc.

- **[LOW]** POSSIBLE SCRIPT FAILURE / divergence from repo convention. Every existing prod script (scripts/audit-lost-links.ts, restore-lost-links.ts, cleanup-production.ts) imports ONLY `@prisma/client` (the dedupe-existing-links.ts cited in CLAUDE.md/MEMORY does not exist on this branch). None reach into `apps/api/src/`. The plan's script imports `getProvider`, `InsightTarget`, `upsertLinkContent`, `platformFromCanonicalKey` from `../apps/api/src/services/...`. apps/api is an Express app, not a package with an `exports` map — importing its `src` files by relative path will, via the registry barrel, also load instagram.provider.ts and facebook.provider.ts (and link-content.service imports `@dashmani/db` + a `@prisma/client` type). Under `cd packages/db && npx tsx ../../scripts/enrich-link-content.ts`, tsx resolves the relative paths by file location (fine) but the transitive `@dashmani/db`/`@dashmani/shared`/`@prisma/client`/`@anthropic-ai/sdk` bare imports must resolve from the hoisted root node_modules — usually OK in this monorepo, but it is an UNTESTED resolution path that no existing script exercises. If apps/api has any module that throws at import time (env assertions, side-effecting bootstrap) it would crash the script.
  - **Where:** Task 5 — backfill script deep-imports apps/api/src service code from a script run inside packages/db
  - **Fix (apply before/while implementing):** Prove resolution explicitly before relying on it: the plan's dry-run (step 3) is the gate — keep it, but add an early assertion that the imports loaded (e.g. log `typeof getProvider`/`typeof upsertLinkContent`) so a resolution failure surfaces immediately rather than as a confusing stack trace. Confirm none of apps/api's imported modules (social-insights barrel, link-content.service) execute side effects at import time (they don't today — registry just constructs a Map, providers only read process.env inside isSupported()). If side effects are ever added, switch the script to import the providers/service directly by file path rather than via the barrel that loads instagram/facebook.

- **[LOW]** Behavioral DIVERGENCE between backfill and cron, not a break today. The cron iterates `getSupportedSlugs()` = providers whose `isSupported()` returns true (env-key-gated) → currently `["youtube"]` only when YOUTUBE_API_KEY is set. The script iterates `getSupportedInsightPlatforms()` = the static shared switch `["youtube"]`, THEN inside the loop calls `getProvider(slug)` and skips if `!provider.isSupported()`. These agree for youtube. But the script's `where: { platform: { equals: slug, mode: "insensitive" } }` filters report_links by the dirty `platform` column (mixed casing, client junk per CLAUDE.md). It then re-filters by `platformFromCanonicalKey(key) !== slug`. A YouTube link mis-tagged in the platform column (e.g. platform='video' or '' but a real youtube.com URL) is INVISIBLE to the script's `platform=youtube` prefilter, so it will never be enriched even though canonicalKey would classify it as yt:. The cron has the identical limitation, so this doesn't regress anything — but the spec's '431 YouTube links' count assumes the platform column is clean, and the backfill may under-cover.
  - **Where:** Task 5, Step 1 — script reuses `getSupportedInsightPlatforms()` (shared) while the cron uses `getSupportedSlugs()` (provider registry)
  - **Fix (apply before/while implementing):** Document the known limitation in the script header (enrichment coverage is bounded by report_links.platform tagging accuracy, same as the cron). Optionally, for the one-time backfill, broaden the prefilter to also pull rows whose URL host is youtube.com/youtu.be regardless of platform tag, then trust `platformFromCanonicalKey` as the authoritative classifier. Not required for safety; flagged so the coverage number in the spec isn't misread.

- **[LOW]** OPERATIONAL, low. The plan's commit message asserts 'no extra quota beyond a trivial per-part unit'. YouTube Data API videos.list cost is 1 unit per call regardless of parts requested (parts do not multiply the documented quota cost for videos.list — it is a flat 1 unit). So the claim is conservatively true and there is no quota regression. The only real change is response payload size grows (snippet.description can be long). The provider has a 10s AbortController; larger payloads over 50-id batches could in rare cases approach the timeout on slow links, marking a batch as `error` and thus writing metric status='error' for those links — which WOULD be a metrics-pipeline behavior change (today those same calls return faster with statistics-only).
  - **Where:** Task 2 — switching YouTube fetch to part=statistics,snippet changes API quota cost per call
  - **Fix (apply before/while implementing):** Note in the plan that adding `snippet` increases response size; if timeouts/`error` statuses rise in the metrics table after deploy, raise TIMEOUT_MS or reduce batch size. This is a monitoring note, not a code change. The byte-identical-metrics claim should be scoped to 'mapping logic byte-identical' (true) rather than 'behavior byte-identical' (response size/timeout profile shifts slightly).

- **[LOW]** SAFE as written, but one subtlety worth pinning. The block is correctly nested inside the inner `try` (before `} catch (writeErr)`) and has its own inner try/catch, so a content failure logs and continues without affecting `succeeded/notFound/errors` accounting or the metric write — matches the hard constraint. The gate `r.status === "ok" && (r.title != null || r.caption != null)` means a real YouTube video with an empty title AND empty description writes NO LinkContent row, so Stage 2 will never see it (no row to extract from). That's acceptable for v1 (no text = nothing to extract) but differs from the service's own `status:"not_found"` path, which would have recorded the post as fetched-but-empty. Not a regression to existing behavior (LinkContent is new), just a coverage gap.
  - **Where:** Task 4, Step 2 — content upsert placed inside the per-link try, gated on r.title!=null || r.caption!=null
  - **Fix (apply before/while implementing):** Optional: drop the `&& (r.title != null || r.caption != null)` gate and let `upsertLinkContent` decide status (it already sets not_found when no text), so every successfully-polled post gets a LinkContent row with an accurate status and fetchedAt — improving coverage visibility for the §7 coverage banner. If kept gated, note that empty-text posts are intentionally not recorded.

- **[LOW]** INCOMPLETE GATE. Spec §8 item 7 and CLAUDE.md both mandate a full `npm run build` (all apps) before push because shared imports can break apps only caught by the full build. Task 6 runs `tsc --noEmit` on api+shared and four targeted vitest suites only. Phase B touches packages/shared? — no, it only consumes it — but it DOES add an exported barrel symbol path usage; more importantly Phase B is part of a feature whose later phases touch apps/internal. For THIS phase (api + shared + scripts only, no app UI), a full all-apps build is not strictly required to prove Phase B safe, but skipping it contradicts the stated gate and risks a habit of partial verification. The bigger gap: Task 6 never runs the EXISTING insights/daily-report suites against the modified provider+cron beyond the new files — it relies on Task 4 step 3 having run `daily-report`. That's adequate, but the phase should also confirm the build of @dashmani/api compiles for production (tsc -p is dev type-check, not the build).
  - **Where:** Overall — Task 6 verification gate does not run the full `npm run build` (all apps) that CLAUDE.md and spec §8.7 require
  - **Fix (apply before/while implementing):** Add to Task 6: `npm run build -w @dashmani/api` (proves the API actually builds, not just type-checks) and, since this is a multi-phase feature, a note that the FULL `npm run build` gate per spec §8.7 is deferred to the final phase that touches apps/internal but MUST run before any push that ships UI. Keep the targeted vitest run as-is to avoid the ~36 pre-existing failures.


### Phase C — Extract — 6 findings

- **[HIGH]** REGRESSION of the ENTIRE test suite (every existing test, not just new ones). setup.ts runs ONE `TRUNCATE TABLE <list> CASCADE` per beforeEach for ALL tests. Verified: Phase A models do NOT exist in schema.prisma yet (grep count = 0; @@map list ends at link_metrics line 1370) and the corresponding tables do not exist in the DB. If the implementer edits setup.ts before Phase A's `db:push` has actually been applied to the local test DB (the plan's own opening guard admits Phase A may be incomplete), Postgres TRUNCATE on a non-existent table raises an error that aborts the transaction — so beforeEach throws and EVERY test file (auth, rbac, account, analytics, etc.) goes red, not just entity-extraction. This is exactly the 'sabotage something that already works' the user forbade. The plan never gates the setup.ts edit on the tables physically existing.
  - **Where:** Task 1, step 2 — prepending link_content_entities, link_content, entities to the single combined TRUNCATE ... CASCADE in apps/api/tests/setup.ts
  - **Fix (apply before/while implementing):** Make the setup.ts edit conditional/safe: either (a) put the three new names in a SEPARATE statement guarded by `TRUNCATE TABLE ... CASCADE` wrapped so a missing table can't poison the shared truncate — e.g. run them in their own `try/catch` after the main truncate (`await prisma.$executeRawUnsafe('TRUNCATE TABLE link_content_entities, link_content, entities CASCADE').catch(() => {})`), so a not-yet-pushed table degrades gracefully instead of nuking the whole suite; OR (b) hard-block the setup.ts edit behind a verification step that asserts all three tables exist (`SELECT to_regclass('public.entities')` returns non-null) and aborts with a clear message if not. Do NOT merge the new names into the existing single TRUNCATE statement without that guarantee.

- **[MEDIUM]** FALSE-GREEN verification gate. Verified apps/api/tsconfig.json has `"rootDir": "./src"`, `"include": ["src"]`, `"exclude": ["tests"]`. That tsc invocation compiles ONLY src/ — it will NEVER type-check apps/api/tests/entity-extraction.test.ts (excluded) NOR scripts/extract-entities.ts (outside the project root entirely). So a type error in the test file (e.g. the injected fakeLlm signature drifting from RawExtractFn, or `LlmEntity` shape mismatch) or in the script passes the gate and only surfaces at `vitest run` / `npx tsx` runtime. A literal implementer will trust the green tsc and believe the test file is type-safe when it isn't. The plan presents this gate as the safety net it is not.
  - **Where:** Task 11, step 2 — tsc gate `npx tsc --noEmit -p apps/api/tsconfig.json` claimed to be the type-check that must pass before push
  - **Fix (apply before/while implementing):** Drop the implication that this tsc gate covers the test/script. Either run the test suite (`vitest run` already type-checks-by-execution the test) as the real gate for the test file, AND add an explicit `npx tsc --noEmit` over the script using a tsconfig that includes it (or `npx tsx --check`/a dedicated `scripts/tsconfig.json`). At minimum, state in Task 11 that `-p apps/api/tsconfig.json` does NOT cover tests/ or scripts/ and that vitest execution + a script smoke are what validate those.

- **[MEDIUM]** Data-quality regression (duplicate aliases) under the exact concurrency this feature creates. `entity` was read by an EARLIER `prisma.entity.upsert` in the same loop iteration; its `aliases` array is a stale in-memory snapshot. Prisma's `{ push }` is a raw array append with NO database-level dedup. Two concurrent extraction runs (the new 6h cron AND the backfill script can both be live; or two captions in the same batch both surfacing 'sallu' for the same canonical name) will each see `includes('sallu') === false` against their own stale snapshot and BOTH push it, yielding `aliases: ['bhaijaan','sallu','sallu']`. The Task 4 test only proves the single-threaded re-run case, so this never gets caught. Aliases power autocomplete/fuzzy search (spec §3), so dupes degrade that surface.
  - **Where:** Task 4, step 3 — alias merge via `prisma.entity.update({ data: { aliases: { push: alias } } })` guarded only by the in-memory `!entity.aliases.includes(alias)` check
  - **Fix (apply before/while implementing):** Make the alias merge atomic/idempotent: re-read inside a transaction and push only if absent, or better, normalize by reading the row fresh inside the same `prisma.$transaction` as the dedup check, or store aliases such that you can dedup on write. Simplest robust fix: after `push`, do a follow-up normalize (`SET aliases = ARRAY(SELECT DISTINCT unnest(aliases))`) , or guard the whole upsert+alias-merge for one entity in a `$transaction` with a re-read. Add a test that calls resolveAndPersist for two different content rows surfacing the SAME new alias for the SAME canonical name and asserts the alias appears once.

- **[LOW]** Breaks the repo's established script convention and introduces a fragile cross-rootDir import. Verified: ALL three existing scripts (dedupe-existing-links.ts, audit-lost-links.ts, restore-lost-links.ts, cleanup-production.ts) instantiate their OWN `new PrismaClient()` from `@prisma/client` and never reach into `apps/api/src`. The new script reaches across `apps/api/tsconfig.json`'s rootDir boundary and transitively pulls `@dashmani/db`'s prisma singleton + AppError (which pulls express). I verified this DOES resolve at runtime under tsx from the packages/db cwd (probe passed), so it is not an outright break — but it is brittle: it now instantiates TWO prisma clients (the script's own `new PrismaClient()` for the count/preview queries, AND the `@dashmani/db` singleton used inside runEntityExtraction), doubling connections, and any future `apps/api/tsconfig` tightening or an apps/api module-side-effect (env loading, etc.) silently changes script behavior.
  - **Where:** Task 10, step 1 — scripts/extract-entities.ts imports `runEntityExtraction` from `../apps/api/src/services/entity-extraction.service`
  - **Fix (apply before/while implementing):** This is acceptable to keep (it works and reusing runEntityExtraction is good DRY), but: (1) drop the script's own `new PrismaClient()` and instead `import { prisma } from "@dashmani/db"` so there is ONE client (matches what runEntityExtraction uses) — eliminates the double-connection and the disconnect mismatch (the script's `prisma.$disconnect()` currently won't close the singleton runEntityExtraction actually used). (2) Add a note in the task that this is the FIRST script to import from apps/api/src and that the import path is rootDir-crossing-but-tsx-resolvable, so reviewers don't 'fix' it by deleting it.

- **[LOW]** Minor cost/behavior wrinkle, NOT a regression of existing behavior, but worth flagging so it isn't mistaken for a bug later. An errored row gets status='error' and extractedAt stays null. runEntityExtraction excludes it via `status='ok'`, so it is correctly never retried — good (I verified this is self-consistent). HOWEVER, the Task 5 test comment says '...but it WILL be skipped (status != ok)' which is correct, yet there is NO path that ever resets an error row to ok for a retry. That is a product decision (errors are terminal until manual intervention), not a bug — but the plan never states it, so a future maintainer may 'helpfully' change the WHERE to `status IN ('ok','error')` and reintroduce unbounded re-pay on permanently-malformed captions.
  - **Where:** Task 5 — defensive parse test asserts an error row keeps `extractedAt: null` while runEntityExtraction (Task 7) selects `WHERE status='ok' AND extractedAt IS NULL`
  - **Fix (apply before/while implementing):** Add one sentence to Task 7 documenting that error rows are deliberately terminal (excluded by the `status='ok'` filter) and must NOT be re-included in the WHERE without an explicit retry-budget, to prevent a future cost regression. Optionally store the parse-failure reason for observability. No code change required now.

- **[LOW]** No regression found in these areas. Verified: (a) youtube.provider.ts / social-insights.cron.ts / link_metrics table are not referenced or modified by any Phase C task — the metrics-writing path stays byte-identical. (b) Task 9 adds runEntityExtraction6h as a NEW import + NEW setInterval block AFTER the existing runInsights block and explicitly says not to touch runFollowerSync/runInsights — the existing bootstrap stays identical, and the new cron's failure is isolated by its own `.catch`. (c) SUPPORTED_INSIGHT_PLATFORMS in packages/shared stays ['youtube']; Phase C never imports or mutates it. (d) Phase C adds NO route to admin-reports.routes.ts (the search route is a different phase), so route-ordering is untouched here. (e) Schema changes are additive-only (Phase A's CREATE TABLEs); Phase C writes only to the new tables. (f) AppError import into a service/cron is novel for cron/ but harmless. The phase is structurally safe on the user's hard constraint EXCEPT for the setup.ts truncate hazard (finding 1).
  - **Where:** Overall phase — metrics pipeline, social-insights cron, route-ordering, SUPPORTED_INSIGHT_PLATFORMS switch, RBAC, existing schema columns
  - **Fix (apply before/while implementing):** No change needed beyond finding 1. Keep the cron isolated with its own try/catch as written, keep the metrics path untouched, and do not let any later phase fold IG/FB into SUPPORTED_INSIGHT_PLATFORMS as part of this feature.


### Phase D — Search API — 6 findings

- **[HIGH]** This loads EVERY matching ReportLink row in the entire DB into Node memory on every search call, then filters in application code. Production has ~29,773 report_links rows (per MEMORY: dedupe reduced 29,913→29,773). With no `from`/`to` window (the default, and the default the UI typeahead-then-search flow will hit), Task 2's query has NO date filter at all and Task 3's window filter is optional — an unfiltered search pulls all ~30k rows (url+platform+nested account+nested report+employee selects) into a single array on a 2GB Linode that already OOM-kills the `internal` build. Each `canonicalKey()` call re-parses a URL via `new URL()`. This is O(all-links) per request behind an admin endpoint; a few concurrent admin searches or a no-window search can spike memory/CPU and risk an OOM that takes down the API process (pm2), which IS sabotaging working portals (every portal depends on the API). It will pass the tiny-seed tests (4 rows) and look correct, hiding the prod hazard entirely.
  - **Where:** Task 2 step 1 (and Task 3 step 3) — the `prisma.reportLink.findMany({ where: { url: { not: null } } })` / windowed `findMany` that loads links then filters in JS via `canonicalKey(l.url)`
  - **Fix (apply before/while implementing):** Constrain the ReportLink query to the matched entity's keys BEFORE loading, not after. The set of canonicalKeys featuring the entity is already known (`keys` from LinkContentEntity, typically tens-to-hundreds, not 30k). Two safe options: (a) keep the current shape but ALSO require `url: { not: null }` AND push the platform/date window into the DB (Task 3 already does window+platform) — but additionally cap the scan: since canonicalKey can't be expressed in SQL, fetch only rows whose raw `url` could plausibly map to one of `keys` is hard, so instead (b) page the scan or (preferred) add the date window as a HARD default (e.g. default `from` to now-90d when neither bound is given) and document that an unbounded all-time search is intentionally not supported from the UI. At minimum, the plan MUST state that the default (no from/to) path is bounded — either by a default window or by `take`/cursor pagination — and add a test asserting the query does not select all rows unbounded. Do not ship the unbounded `findMany` as the steady-state code path.

- **[MEDIUM]** The reasoning is factually wrong, which will mislead a literal implementer into placing the route by the WRONG criterion and writing a test that asserts a false mechanism. `admin-reports.routes.ts` is mounted bare (`router.use(adminReportsRoutes)` in routes/index.ts) and its routes use FULL paths. Express path matching is per-segment: `/admin/reports/:reportId` only matches paths of the form `/admin/reports/<one-segment>`. `/admin/link-search` and `/admin/entities` have a DIFFERENT second segment (`link-search`/`entities` ≠ `reports`), so `:reportId` can NEVER capture them regardless of declaration order. The Task 6 test comment ('If /:reportId had captured link-search, getReportById would 404/throw') describes an impossible scenario; the test would pass for the wrong reason and provides zero real ordering protection. Worse, the Task 8 step-3 grep gate asserts the new routes' line numbers are LOWER than `:reportId` — if a future refactor legitimately moves them after `:reportId` (which is harmless), that gate fails spuriously and blocks an otherwise-correct change.
  - **Where:** Task 6 step 3 + step 4 comment — the claim that `GET /admin/reports/:reportId` could capture `/admin/link-search`, and the instruction that the new route 'MUST be before /:reportId'
  - **Fix (apply before/while implementing):** Drop the false 'before /:reportId' rationale for these two routes. Placement order does not matter for them because the second path segment differs. Keep them grouped with the other admin search/aggregate routes for readability if desired, but change the code comment to state the real reason (grouping/convention, NOT capture-avoidance). Rewrite the Task 6 ordering test to actually assert what matters: that `GET /admin/link-search?q=salman` returns the structured search payload (kind/totalPosts) — that alone proves correct resolution. Remove or relax the Task 8 step-3 grep gate so it does not hard-fail on a benign reorder; if you want a real guard, assert resolution behavior in a test, not source line ordering.

- **[MEDIUM]** The alias match is EXACT-per-element and lowercased, while seeded aliases are stored lowercase ('bhaijaan','sallu','srk'). This passes the tests, but the design is silently inconsistent with how the rest of the codebase resolves user-typed identifiers and creates a real-usage trap, not a test failure: a partial alias ('bhai') will never match, and an alias stored with ANY uppercase (Phase B/AI extraction may write 'Bhaijaan' or 'SRK') will never match a lowercased query because `hasSome` does not honor `mode:'insensitive'` for String[] in Prisma. So entities resolvable by name will silently fail to resolve by alias depending on stored casing — an admin searching a known alias gets a no-match coverage screen instead of results, which reads as 'the feature is broken'. This won't sabotage existing portals but ships a latently-broken alias path that the tests certify as working.
  - **Where:** Task 2 step 1 — entity resolution `where.OR` uses `{ aliases: { hasSome: [q.toLowerCase()] } }` (exact, lowercased) combined with `{ canonicalName: { contains: q, mode: 'insensitive' } }`
  - **Fix (apply before/while implementing):** Make alias storage casing a hard contract and document it where Phase A/B write aliases: normalize aliases to lowercase at write time (Phase A/B), OR change resolution to be casing-tolerant. Since `hasSome` can't do insensitive matching, the robust fix is to store aliases lowercased on write and lowercase the query (as done) — but the plan must add an explicit note/assertion that ALL alias writers lowercase, and ideally a test seeding a mixed-case alias to prove resolution. Do not leave the exact-lowercase `hasSome` as the only alias path without pinning the write-side casing convention.

- **[LOW]** `new Date('2026-06-20')` parses as midnight UTC. `daily_reports.date` is `@db.Date` (stored as date-only / midnight UTC), so for the seeded test the `lte` inclusive-upper-bound works. But the 'inclusive' claim is fragile and inconsistent with the rest of the codebase's IST convention (CLAUDE.md: all 'today' date math must use IST helpers; raw `new Date(yyyy-mm-dd)` is UTC and is explicitly called out as a recurring bug). A `to=2026-06-20` request is `lte 2026-06-20T00:00:00Z`; because the column is date-only it happens to include the whole 2026-06-20, but this is luck of the `@db.Date` type, not intent — and it diverges from how every other admin-reports endpoint in this same file (employee-stats, links-analytics, leaderboard) computes windows via `istMidnight`/`dateToIST`. An admin filtering 'up to today' may get IST-vs-UTC edge mismatches between 12am–5:30am IST relative to the other reports pages, producing confusing 'why does link-search show fewer than the reports page' discrepancies.
  - **Where:** Task 3 step 3 — date window filter `where.report = { date: { gte: new Date(params.from), lte: new Date(params.to) } }` with the interface comment 'YYYY-MM-DD inclusive upper bound'
  - **Fix (apply before/while implementing):** Use the same date helpers the neighboring routes use rather than raw `new Date(param)`. At minimum, for the `to`/upper bound, normalize to end-of-day or use the existing `istMidnight`/`dateToIST` pattern from admin-reports.routes.ts so link-search windows are byte-consistent with employee-stats/links-analytics. Add a one-line comment that `daily_reports.date` is `@db.Date` so the inclusivity is explicit, and keep the comparison consistent with the IST convention to avoid a 12am–5:30am off-by-one that contradicts the other Reports pages.

- **[LOW]** Not a regression to existing behavior, but an inconsistency that the codebase's conventions (and CLAUDE.md's 'business logic / shared utilities' rules) discourage: every other admin-reports route either uses `validate(schema,'query')` (e.g. `/admin/reports`) or, for ad-hoc checks like `/admin/growth/record`, also hand-rolls — so it's tolerated, but the hand-rolled envelope can drift from `error()`'s shape (the shared `error()` helper is already imported-by-pattern across the codebase). The bigger latent issue: there is NO input length/shape cap on `q`. A pathological `q` (very long string, or a value that matches a huge number of entities) flows straight into `prisma.entity.findMany` with `contains` (a full table scan, no `take` on the search path unlike the typeahead which caps at 10) and then into the unbounded ReportLink scan. Combined with finding #1 this widens the DoS surface on an admin endpoint.
  - **Where:** Task 6 step 4 — new route handler returns a 400 by hand-rolling `res.status(400).json({ success:false, error:{ code:'VALIDATION_ERROR', message:'q is required' } })` instead of using the shared `error()` helper / `validate` middleware that every other route in this file uses
  - **Fix (apply before/while implementing):** Use the shared `error(res, 'VALIDATION_ERROR', 'q is required', 400)` helper for envelope consistency (it's already importable from ../utils/response, same as `success`). Add a sane cap on `q` (e.g. reject >200 chars) and a `take` limit on the entity resolution `findMany` in `searchLinksByEntity` (mirror the typeahead's `take: 10` or similar) so a broad query can't resolve to an unbounded entity set that then drives an unbounded link scan. These are additive guards; they don't change the happy-path test outcomes.

- **[LOW]** Correct and safe GIVEN the spec's guarantee that the only FKs into/among these tables are LinkContentEntity→LinkContent and LinkContentEntity→Entity (no FK from LinkContent to ReportLink). The `CASCADE` keyword is therefore inert here. The only real hazard: if a future phase (or a literal implementer in Phase A) adds ANY FK from an EXISTING table to one of these three (violating the additive-only rule), `TRUNCATE ... CASCADE` would silently wipe rows in that existing table during the test run — but tests run against a local/test DB, and setup.ts already truncates everything each test, so blast radius is contained to the test DB, not prod. Net: no production risk, but the `CASCADE` is a loaded footgun if the additive-only invariant is ever broken.
  - **Where:** Task 1 step 1 — `cleanLinkEntityTables()` does `TRUNCATE TABLE link_content_entities, link_content, entities CASCADE` and the plan instructs NOT to edit setup.ts
  - **Fix (apply before/while implementing):** Keep it, but add a comment in the test that CASCADE is only safe because no existing table FKs into these three (per spec §4: no FK from link_content to report_links). Optionally drop `CASCADE` and TRUNCATE in strict child→parent order (link_content_entities; link_content; entities) since the plan already orders them correctly — removing CASCADE makes any accidental future cross-table FK fail loudly in the test instead of silently truncating an existing table. No change to setup.ts (correctly left byte-identical).


### Phase E — Search UI — 6 findings

- **[HIGH]** This is the single largest regression vector in the phase, and it is INHERITED, not caused by this phase's own code. A full `npm run build` rebuilds EVERY app (client, hr, jobs, and the auth pages that import the load-bearing `shared.tsx`). If any unrelated app currently has a latent build break (or if a prior session left a stale `apps/*/.next`), the implementer — being literal — will see this build fail, attribute it to their Phase E work, and may start 'fixing' files outside this phase. CLAUDE.md's 2026-05-19 incident is exactly this: a build/cache symptom misdiagnosed as broken page code, destroying working hero pages. The plan does NOT establish a clean-build baseline BEFORE Task 1, so there is no way to attribute a Task-7 failure to Phase E versus a pre-existing condition.
  - **Where:** Task 7, step 3 — `npm run build` (full all-apps build) as the verification gate.
  - **Fix (apply before/while implementing):** Add a Task 0 (before Task 1): run `cd /Users/tabish/Desktop/dashmani-platform && npm run build` on a clean tree and confirm `Tasks: N successful, N total` with zero ERROR lines, capturing the baseline. In Task 7, instruct: if the full build fails, FIRST `git stash` the Phase E changes and re-run the build — if it still fails, the break is pre-existing and OUT OF SCOPE; restore the stash and report, do NOT edit any non-Phase-E file. Also have Task 7 step 1 verify `apps/*/.next` is absent/clean before building (the plan already kills dev ports but does not clear stale caches).

- **[HIGH]** This is Phase E (Stage 3 UI). Verified against the repo: neither `/admin/link-search` nor `/admin/entities` exists in `apps/api/src/routes/` yet. Tasks 1–7 are self-contained TypeScript/build steps and WILL pass without the backend (the hooks just call `apiFetch` against paths that 404 at runtime — no compile dependency). That is fine. The trap is Task 8 (manual smoke), which assumes 'Phases A–D shipped the Entity/LinkContent tables, the extraction pipeline, the GET /admin/link-search + GET /admin/entities endpoints, and that the local DB has at least one extracted YouTube entity'. If Phase E is executed before Phase D is merged/running, Task 8's autocomplete and results steps cannot pass, and a literal implementer may either (a) declare the UI broken and start editing it, or (b) attempt to build the missing endpoints inside this UI phase — scope creep that risks touching `admin-reports.routes.ts` route ordering, which the safety spec §8.5 flags as a place that can regress existing report routes.
  - **Where:** Phase ordering — Tasks 1–7 author, type-check, commit, and full-build UI that calls `GET /admin/link-search` and `GET /admin/entities`, which Phase D is supposed to ship.
  - **Fix (apply before/while implementing):** Add an explicit precondition gate at the very top of Task 8 (and ideally a note at the top of Phase E): 'STOP if `grep -rn link-search apps/api/src/routes/` returns nothing — Phase D has not shipped. Tasks 1–7 (code + build) are safe to complete and commit now; Task 8 (smoke test) is BLOCKED until Phase D endpoints exist. Do NOT create API routes from this phase.' This keeps the UI phase shippable independently while preventing the implementer from drifting into backend files.

- **[MEDIUM]** False confidence — this test CANNOT detect the route-ordering regression it claims to guard against. Verified: `authenticate` (apps/api/src/middleware/auth.ts:15-17) returns the same `{success:false,error:{code:UNAUTHORIZED}}` 401 envelope for a missing Bearer header. The `/:reportId` handler in admin-reports.routes.ts ALSO sits behind `authenticate`. So if `/admin/link-search` were mis-declared AFTER `/:reportId` and captured as `reportId='link-search'`, an unauthenticated curl would STILL return an identical 401 JSON envelope — the test passes either way. The plan's stated discriminator ('must not be ... a report not found error') never fires for a tokenless request, because auth rejects before the handler runs. The implementer will get a green check while the ordering bug (the exact thing spec §8.5 calls out as able to regress existing report routes) goes undetected.
  - **Where:** Task 8, step 3 — curl `GET /v1/admin/link-search?q=test` with no token and treat a `{success:false}` 401 envelope as proof 'the route exists and is not swallowed by /:reportId'.
  - **Fix (apply before/while implementing):** Make the curl test authenticated so it reaches the handler: obtain an access token (login as admin@digitalsukoon.com via `POST /v1/auth/login`) and curl `GET /v1/admin/link-search?q=test` with `Authorization: Bearer <token>`. A correctly-ordered route returns the search-result envelope (`{success:true,data:{...coverage...}}` or a documented empty/disambiguation shape); if it instead returns a 'report not found'/invalid-reportId error, that proves `/:reportId` captured it — a route-ordering bug to send back to the API phase. Keep the tokenless curl only as a liveness check, not as ordering proof.

- **[LOW]** The justification is factually wrong, though the effect is cosmetic-only. Verified against sidebar.tsx: NO existing nav item is a path-prefix of another (full href list checked — `/reports`, `/teams`, etc. are all disjoint; the existing `/reports` children `links`/`leaderboard`/`[employeeId]` are NOT in the nav). The active check `pathname === href || pathname.startsWith(href + "/")` will light up BOTH 'Link Reports' (via `startsWith('/reports/')`) and 'Link Search' (exact) when on `/reports/link-search`. That two-items-active state is NEW behavior this plan introduces, not pre-existing precedent. It does not break anything functional (both links still route correctly), but a literal implementer who hits the QA observation 'two sidebar items are highlighted at once' may treat it as a bug and 'fix' the shared `NavItem` active logic — which IS used by every other nav item and would regress all of them.
  - **Where:** Task 6 — adding `{ href: "/reports/link-search", ... group: null }` directly after `/reports`, with the justification that the resulting double-highlight 'matches how the existing nav already treats child routes; no override needed.'
  - **Fix (apply before/while implementing):** Either (a) keep the dual-highlight but correct the plan's comment to 'this is new; it is acceptable and intentional — do NOT alter the shared NavItem active logic to fix it,' or (b) preferred: scope the `/reports` parent's active state so it does not light up on the `link-search` child, by changing only its check to an exact/segment match (e.g. exclude `/reports/link-search`) — local to that one item, leaving the shared `NavItem` logic untouched. Whichever is chosen, explicitly forbid editing the shared active-state function.

- **[LOW]** No regression to existing behavior (these are new files), but a correctness/robustness gap that can make the new page look broken and tempt the implementer to 'fix' working code. `apiFetch<T>` (api.ts:38) THROWS on a non-success envelope (e.g. the route 404s before Phase D, or a 500). SWR will surface that as `error`, and the page never destructures `error` — it only reads `data`. On a thrown fetch the page silently shows the empty/'No results' state with no signal that the request actually failed, which is indistinguishable from a genuine zero-result. Separately, the field contract (`coverage.{enriched,total}`, `entity.aliases`, `posts[].dupCount`, `channels[].accountId/displayName/handle/platform/postCount`) is asserted by the UI but the endpoint does not exist yet — any field-name drift between Phase D's actual response and these literal reads yields a blank UI with no error.
  - **Where:** Tasks 1 & 2 — `useLinkSearch` / `useEntities` call `apiFetch(url)` and pages read `(searchData as any)?.data` / `(suggestData as any)?.data`, then Task 3 reads `result.coverage`, `result.entity`, `result.posts[].dupCount`, `result.channels[].accountId`, etc.
  - **Fix (apply before/while implementing):** In Task 3, also pull `error` from both hooks (`const { data, isLoading, error } = useLinkSearch(...)`) and render a small inline error state when `error` is set (distinct from 'no results'), matching the cream/ink card style — so a 404/500 is visibly attributable to the API, not the page. And add a one-line note to Tasks 1–4: the result/coverage/channel/post field names are the contract from spec §7 — if Phase D's response differs, reconcile in Phase D, do NOT silently rename fields in the page to match a divergent backend.

- **[LOW]** Confirmed LOW for this specific phase. Phase E touches only NEW files (`use-link-search.ts`, `use-entities.ts`, `reports/link-search/page.tsx`, `reports/link-search/loading.tsx`) plus two ADDITIVE lines in sidebar.tsx (one import token, one nav entry). It does not import or modify: the social-insights provider/cron, `SUPPORTED_INSIGHT_PLATFORMS`, schema.prisma, any API route file, RBAC, or any existing page. All design tokens it uses (`font-display`, `v3-card`, `v3-card-sm`, `nav-active`, `pop-in`, `bg-rule`, `bg-muted`, `text-terra`, `text-ink-4`, `shadow-hard`) are verified present in apps/internal globals.css/tailwind.config.ts, so it cannot fail the build on a missing class. There is no `apps/internal/src/app/reports/layout.tsx`, so the new child route inherits only the root layout — no per-section layout to perturb. The phase correctly avoids `npm run build` while dev servers run and uses per-app `tsc`. The residual risks are the four above (build-baseline attribution, phase-ordering/Task-8 dependency, the false-confidence curl, and the cosmetic double-highlight) — none of which corrupt existing working behavior if the fixes are folded in.
  - **Where:** Overall scope check against the hard constraint (existing metrics pipeline, social-insights cron, SUPPORTED_INSIGHT_PLATFORMS switch, schema, RBAC, route ordering, existing portal UI/build/tests).
  - **Fix (apply before/while implementing):** No structural change needed. Fold in the four fixes above. The phase is safe to execute for Tasks 1–7 even before Phase D lands; only Task 8 must be gated on Phase D.

