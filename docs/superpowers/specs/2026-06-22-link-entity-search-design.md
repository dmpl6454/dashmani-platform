# Link Entity Search — Design Spec

**Date:** 2026-06-22
**Status:** Design (pending user approval → implementation plan)
**Author:** brainstorming session with Tabish

---

## 1. The problem

The admin portal needs a **staple search feature**: an admin types a person's name — e.g. `Salman Khan` — and sees **how many posts feature that person, on how many channels**, across all uploaded links (`report_links`, ~27k rows on prod).

### The hard constraint that shapes everything

`ReportLink` stores only `{ url, platform, accountId, likes/comments/views, description? }`. The `description` column is empty in practice — employees Smart-Paste raw URLs, they don't type captions. **There is no post text in the database to search against.** A URL like `https://instagram.com/reel/CxYz123/` is opaque: nothing in it names who's in the post.

Therefore the feature is not a SQL query. The real work is a pipeline that **enriches** each link with its actual caption/title, **extracts** the people/topics from that text, and only then makes it **searchable**. Matching/UI is the easy 20%.

---

## 2. Decisions (confirmed with user)

| Decision | Choice | Why |
|---|---|---|
| **What to match on** | Post **content** (caption / title) — *Option A* | Most powerful, the honest meaning of "search the database". Not account-tagging, not vision/face-recognition. |
| **How to extract entities** | **LLM** (Claude) reads caption → resolves to **canonical entities** — *Option C* | Handles multilingual / emoji / "Bhaijaan → Salman Khan" that `ILIKE` and alias-dictionaries can't. Canonical resolution prevents count fragmentation. |
| **Sequencing** | Build full pipeline now, **ship YouTube-first**, light up IG/FB through the same pipeline when the Meta token lands — *Option A* | YouTube text is fetchable today (431 links). IG/FB are blocked on Meta App Review (external, days–weeks). No reason to block a working feature on that gate. |
| **Dedup in results** | **Show same-vs-unique, never collapse** | User correction: results must show *every* row, grouped by post, reporting both total posts and unique posts. Internal enrichment still fetches each unique post once (pure cost optimization). |

---

## 3. Architecture — a 3-stage pipeline

Each stage runs independently, is independently testable, and writes to its own table. A failure in one stage never corrupts another. **All three stages reuse the existing `social-insights` provider/cron architecture** — this is an *extension*, not a parallel system.

```
report_links (existing, ~27k rows — UNTOUCHED)
   │
   │  ① ENRICH   (extend existing social-insights cron — fetch caption/title)
   ▼
LinkContent          { canonicalKey, platform, title?, caption?, raw?, status, fetchedAt }
   │                  keyed on canonicalKey() → each unique post fetched ONCE
   │
   │  ② EXTRACT  (new cron — un-extracted captions → Claude → canonical entities)
   ▼
LinkContentEntity    { linkContentId, entityId, confidence }   (join table)
   │   ▲
   │   └── Entity     { id, canonicalName, type, aliases[], createdAt }
   │
   │  ③ SEARCH   (new admin endpoint + UI — join entity → content → links → channels)
   ▼
GET /v1/admin/link-search?q=salman+khan
   → { entity, totalPosts, uniquePosts, duplicatePosts, channelCount,
       channels:[…], posts:[{ canonicalKey, url, account, employee, date, dupCount }],
       coverage:{ enriched, notYetEnriched, total } }
```

### Why keyed on `canonicalKey`, not `reportLink.id`

The same reel is submitted by many employees and re-created on every resubmit (delete-and-recreate). Keying `LinkContent` on `canonicalKey()` (the existing `ig:`/`yt:`/`fb:` content-id used for dedupe — see `packages/shared/src/utils/canonical-url.ts`) means **we fetch + LLM-extract each unique post exactly once**, regardless of how many `ReportLink` rows point at it. There are far fewer unique posts than rows, so 27k rows is cheap, and we never re-pay for a duplicate.

Search joins back the other way: `Entity → LinkContentEntity → LinkContent.canonicalKey → all matching ReportLinks → accounts/channels → employees`. **No row is collapsed in results** — `canonicalKey` is used to *count* uniques and group duplicates, not to hide them.

### Why a canonical `Entity` table (not free-text tags)

The LLM resolves "Bhaijaan", "Sallu", "@beingsalmankhan", "सलमान" all to one `Entity { canonicalName: "Salman Khan" }`. Counts never fragment. The Entity table also powers search autocomplete and lets an admin merge/rename entities later without re-running extraction. The LLM is given the current list of known entities each call and told to reuse an existing canonical name when the person matches — new entities are only created when genuinely unseen.

---

## 4. Data model (additive only — see §8 safety)

Three **new** tables. **Zero changes to existing tables.** `db push` is purely `CREATE TABLE` (additive) — verified against the "always diff before db:push" rule in CLAUDE.md.

```prisma
model Entity {
  id            String   @id @default(uuid())
  canonicalName String                       // "Salman Khan"
  type          String   @default("PERSON")  // PERSON | TOPIC | BRAND | OTHER
  aliases       String[]                      // ["bhaijaan","sallu","beingsalmankhan","सलमान"]
  createdAt     DateTime @default(now())      @map("created_at")
  updatedAt     DateTime @updatedAt           @map("updated_at")
  links         LinkContentEntity[]
  @@unique([canonicalName])
  @@index([type])
  @@map("entities")
}

model LinkContent {
  id           String   @id @default(uuid())
  canonicalKey String                         // ig:CxYz / yt:dQw4 / fb:123 / full-url fallback
  platform     String                         // classified by URL, not the dirty platform column
  title        String?  @db.Text              // YouTube title
  caption      String?  @db.Text              // IG/FB caption (and YouTube description)
  status       String   @default("pending")   // pending | ok | not_found | private | unsupported | error
  extractedAt  DateTime?                       // null until stage ② runs; set when entities extracted
  fetchedAt    DateTime?                       // when caption/title last fetched
  createdAt    DateTime @default(now())        @map("created_at")
  updatedAt    DateTime @updatedAt             @map("updated_at")
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

**Note:** `LinkContent` deliberately has **no FK to `ReportLink`** — the join is by `canonicalKey` computed on read (same philosophy as the dedupe key: raw URLs stay in `report_links`, the key is derived). This survives the delete-and-recreate churn on `report_links` with zero re-linking work.

---

## 5. Stage ① — Enrich (fetch caption/title)

**Reuses the existing provider pattern verbatim.** The `InsightProvider` interface and the `social-insights.cron.ts` loop already iterate links per supported platform and batch-call APIs. We make two small, backward-compatible additions:

1. **Extend `InsightFetchResult`** (in `social-insights/types.ts`) with two optional fields: `title?: string | null; caption?: string | null`. Optional → every existing provider/consumer keeps compiling unchanged.
2. **YouTube provider:** change `part=statistics` → `part=statistics,snippet` in the existing batched call. `snippet.title` + `snippet.description` come back in the *same request* — no extra quota cost beyond a trivial per-part unit. Map them into the new result fields. The existing metrics behavior is byte-for-byte unchanged.
3. **IG/FB providers (when Meta token lands):** the same Graph API call that fetches `like_count,comments_count` also returns `caption` — add `caption` to the `fields` list. One call, both purposes.

A small **`link-content.service.ts`** upserts the fetched text into `LinkContent` keyed by `canonicalKey`. This can be invoked from the existing cron (write content alongside metrics) **or** run as a standalone backfill script — both call the same service function. Critically: **the metrics-writing path is not modified** — content upsert is an additional `try/catch`-wrapped write that, if it throws, logs and continues without affecting metric snapshots.

**Backfill:** a `scripts/enrich-link-content.ts` (dry-run default, like every other prod script in this repo) walks distinct `canonicalKey`s for supported platforms and fills `LinkContent`. For YouTube that's ~431 rows once.

---

## 6. Stage ② — Extract (caption → canonical entities)

A new `entity-extraction.service.ts` and a new cron `entity-extraction.cron.ts` (bootstrapped in `index.ts` next to the existing `setInterval(runInsights, 6h)` — same pattern).

- Selects `LinkContent` rows where `status='ok'` AND `extractedAt IS NULL` (un-extracted only — **idempotent, never re-pays**).
- Batches captions and calls Claude via the **exact existing AI pattern** (`ai.service.ts`): `import Anthropic from "@anthropic-ai/sdk"`, lazy `getClient()` singleton, `client.messages.create({ model, max_tokens })`, `AppError(500,"AI_NOT_CONFIGURED",…)` guard. Model: **Claude Haiku** (`claude-haiku-4-5-20251001`) — cheap, fast, sufficient for entity extraction at 27k scale.
- **Prompt contract:** given a caption + the current list of known `Entity.canonicalName`s, return strict JSON: `[{ canonicalName, type, confidence, isNew }]`. The model is instructed to **reuse an existing canonical name** when the person matches (resolving aliases), and only mark `isNew:true` for a genuinely unseen person/topic. Output parsed defensively (JSON-only response, wrapped in try/catch; a parse failure marks the row `error` and moves on — never throws the batch).
- Upserts `Entity` rows (new canonical names + merge aliases) and `LinkContentEntity` join rows, then stamps `LinkContent.extractedAt`.
- **Cost control:** one extraction per unique caption, cached forever via `extractedAt`. ~27k captions one-time on Haiku ≈ cents. New links trickle through the 6h cron.

**Cost & blast-radius cap:** the cron processes a bounded number of captions per run (e.g. 500) so a backfill can't spike the Anthropic bill or block the event loop. A `scripts/extract-entities.ts` (dry-run default) does the one-time bulk backfill under manual supervision.

---

## 7. Stage ③ — Search (admin endpoint + UI)

### API

`GET /v1/admin/link-search?q=<text>&from=<date>&to=<date>&platform=<slug>`

- **Route placement:** in `admin-reports.routes.ts`, declared **before** `/:reportId` (the established ordering rule — Express would otherwise capture `link-search` as a reportId). Mirror neighbors exactly: `authenticate, requirePermission("reports","view")`. Response uses the standard `{success,data}` envelope.
- **Resolution:** fuzzy-match `q` against `Entity.canonicalName` + `aliases` (Postgres `ILIKE`/trigram). If multiple entities match, return a small disambiguation list. If none, return empty with `coverage` so the admin sees *why* (e.g. "0 results — but only 431 of 27,323 links are enriched so far").
- **Result shape** (the user's same-vs-unique requirement):
  ```
  {
    entity: { canonicalName, type, aliases },
    totalPosts: 47,          // every matching ReportLink row
    uniquePosts: 31,         // distinct canonicalKey
    duplicatePosts: 16,      // totalPosts - uniquePosts
    channelCount: 12,        // distinct SocialAccount
    channels: [{ accountId, handle, displayName, platform, postCount }],
    posts:   [{ canonicalKey, url, platform, account, employee, date, dupCount }],
    coverage: { enriched, notYetEnriched, total, byPlatform: {…} }
  }
  ```
- **Public-PII rule honored:** this is an internal admin endpoint, so employee identity is expected — but it follows the existing `admin-reports` select conventions, no new UUID leaks to any public surface.

### UI

New page **`apps/internal/src/app/reports/link-search/page.tsx`** (or a top-level `/search` entry — final placement decided in the plan). Search box with entity autocomplete, a summary strip (**Total / Unique / Duplicates / Channels**), a channel breakdown table, and a results list with duplicate rows visibly grouped and badged. A persistent **coverage banner** ("Searching 431 of 27,323 enriched links — Instagram/Facebook enrichment pending Meta API") so the number is never misread as the whole database. Uses the existing internal-portal SWR + `apiFetch` + `@dashmani/ui` patterns; **no new auth or token handling.**

---

## 8. Safety — "do not break anything that works" (first-class requirement)

This is a hard requirement, not a nicety. Concrete guarantees:

1. **Existing tables untouched.** Only three `CREATE TABLE`s. `db push` diff is purely additive — no `ALTER`, no `DROP`, no column changes to `report_links` / `link_metrics` / anything. (Follows the CLAUDE.md "always diff before db:push; it silently drops columns" rule — here there's nothing to drop.)
2. **Existing metrics pipeline preserved.** The YouTube provider change is `statistics` → `statistics,snippet` (superset of the same call) plus *optional* result fields. The metrics-writing code path is unchanged; content writes are additive and independently `try/catch`-guarded so a content failure can never fail a metric write.
3. **`SUPPORTED_INSIGHT_PLATFORMS` is the single switch** — unchanged (`["youtube"]`). IG/FB stay dark until their providers + Meta token are live, exactly as today.
4. **New cron is isolated.** Entity extraction is a separate `setInterval` with its own try/catch (matching the existing `runSocialInsightsRefresh().catch(...)` bootstrap). If Anthropic is down or the key is missing, it logs and no-ops — the rest of the API is unaffected.
5. **New route is additively placed** before `/:reportId`, same auth/RBAC as its neighbors — no change to any existing route's matching.
6. **All prod scripts dry-run by default**, require explicit `--apply` (repo convention — see `scripts/cleanup-production.ts`, `dedupe-existing-links.ts`).
7. **Verification gate before any push:** `tsc --noEmit` on api + shared + internal, then full `npm run build` (all apps — auth pages import shared components only caught by the full build, per CLAUDE.md). No `npm run build` while dev servers run (poisons `.next`).
8. **No frontend env/URL changes** — the search page reads `NEXT_PUBLIC_API_URL` like every other page; the deploy `.env.local` overwrite covers prod.

---

## 9. Coverage reality (honest, by design)

| Platform | Links | Searchable text | When |
|---|---|---|---|
| YouTube | 431 | `snippet.title`+`description` — fetchable **today** | This cycle |
| Instagram | 19,526 (~18,200 clean shortcodes) | `caption` via Graph API | When Meta token + App Review land |
| Facebook | 7,310 (~1,188 clean `/reel/<id>`) | `caption` via Graph API | Partial — ~84% are opaque `/share/r/` redirects with no queryable ID; those may never resolve |
| Snapchat | 56 | — | Out of scope |

The UI shows coverage explicitly. We never imply the whole DB is indexed when it isn't.

---

## 10. Out of scope (YAGNI)

- Vision/face-recognition on thumbnails (rejected — Option C is text-only).
- Resolving Facebook opaque `/share/r/` redirects (best-effort later; not in v1).
- Client-portal exposure (admin-only feature).
- Re-running extraction on unchanged captions (idempotency forbids it).
- Real-time extraction on submit (the 6h cron + backfill is sufficient; submit path stays untouched — load-bearing per the Anish/dedupe history).
