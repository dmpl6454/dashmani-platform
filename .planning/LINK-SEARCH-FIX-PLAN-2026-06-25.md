# Link Search Enrichment Reliability — Implementation Plan (2026-06-25)

Branch: `fix/link-search-enrichment-reliability`. Root-cause audit: [LINK-SEARCH-ACCURACY-AUDIT-2026-06-25.md](LINK-SEARCH-ACCURACY-AUDIT-2026-06-25.md).

**Goal:** Make IG/FB caption enrichment run **reliably and observably** every cycle so forward coverage (today-onward) is accurate end-to-end; make the historical ceiling **honest in the UI**; add a **manual admin trigger** with proper UI messaging (what enrichment does, how long, API-issue states). Accept the firehose historical ceiling (Meta physics) and label it honestly.

**Verification stack:** Each task: `tsc --noEmit` for the touched workspace + relevant Vitest. Final: full `npm run build`. Then deploy + force a manual refresh on prod + confirm yesterday's Ananya IG posts get harvested + searchable.

**No `db:push` required** (code + one new route only).

---

## Task 1 — Robust IG account discovery (RC-2)

**File:** `apps/api/src/services/social-insights/instagram.provider.ts`

**Problem:** `discoverIgUserIds()` requests `fields: "instagram_business_account{id}"` (nested sub-selection), which **intermittently returns HTTP 500** from the live Graph API. On `!res.ok` the function `break`s and silently returns `[]` → zero IG accounts → zero harvest that run. The sibling `meta-followers.ts` already uses the robust **bare** field.

**Change:**
1. Line ~111: change `fields: "instagram_business_account{id}"` → `fields: "instagram_business_account"` (bare — verified live to return the IG node reliably; the `{id}` sub-selection is what 500s).
2. Update the doc comment at line ~19 accordingly (and the block comment describing step 1) to state the bare-field requirement, mirroring `meta-followers.ts`'s documented rationale.
3. Add a **loud warning** when discovery completes with **zero** IG ids while the token is configured: `console.warn("[social-insights/instagram] discovery returned 0 IG accounts — Graph API issue? (token set)")`. This converts the previously-silent failure into an observable one.
4. Keep the `res.rateLimited` early-break and `MAX_ACCOUNT_DISCOVERY_PAGES` guard exactly as-is.

**Tests (`instagram.provider.test.ts`):** add/adjust a test that the mocked `me/accounts` response uses the bare-field shape `{ data: [{ instagram_business_account: { id } }] }` and that a zero-discovery result triggers the warn (spy) without throwing. Don't break existing tests.

**Acceptance:** `discoverIgUserIds` uses the bare field; zero-discovery logs a warning; existing IG provider tests pass.

---

## Task 2 — Per-provider isolation + always-log summary + completion log (RC-1 observability)

**File:** `apps/api/src/cron/social-insights.cron.ts`

**Problem:** A slow/throwing provider can prevent the run from printing its summary and the final `[social-insights] done`. We need each provider wrapped so one provider's failure can't starve another, and every provider must always print a summary line (even on 0/skip/error), plus the run must always print `done`.

**Change (NON-DESTRUCTIVE to existing metric/harvest logic):**
1. Wrap the **entire per-`slug` body** (steps 1–4: query, target-build, fetch, snapshot, harvest, re-heal) in a `try/catch` so a throw in one provider is logged as `[social-insights/${slug}] run failed:` and the loop **continues** to the next provider.
2. Ensure the existing summary `console.log` (the `targets.length → polled/ok/not_found/errors` line) is reached on **every** path, including `targets.length === 0` (it already logs "no links to poll" — keep) and the new catch path (log a failure summary).
3. After the harvest block, add a per-provider harvest-summary line **even when 0 harvested**, so the absence of harvest is visible: `[social-insights/${slug}] harvested N/M feed-map captions` (currently only logged when `harvested.length > 0` — also log a `0 harvested` line).
4. The final `[social-insights] done in Xms` must always print (it's after the loop — ensure no early `return`/throw escapes it; the per-provider try/catch guarantees this).
5. Do **not** change the metric-write, link-content upsert, or re-heal SQL. Do **not** change batch size or rate-limit handling.

**Tests:** if a cron test harness exists, assert the loop continues past a throwing provider and that `done` logs. If no harness, keep it test-light (the logic is logging + try/catch) and rely on tsc + manual prod verification.

**Acceptance:** A throwing provider doesn't abort the run; every provider prints a summary; `done in Xms` always prints.

---

## Task 3 — Host-match guard in target build (RC-4 noise + waste)

**File:** `apps/api/src/cron/social-insights.cron.ts`

**Problem:** Dirty `report_links.platform` means FB URLs are labeled `instagram` and vice-versa, so the IG provider tries to extract shortcodes from `facebook.com/...` URLs → thousands of `could not extract targetId` warnings + wasted target-build work. The query already filters by `platform == slug`, but the URL host often disagrees with the label.

**Change:**
1. In the target-build loop, before calling `provider.extractTargetId(url)`, the existing behavior logs a warn on null. **Reduce the noise**: when `extractTargetId` returns null, only `console.warn` if the URL host plausibly matches the provider (e.g. for IG: host contains `instagram.com`; for FB: host contains `facebook.com` or `fb.watch`). For a clear cross-platform mislabel (IG provider given a `facebook.com` URL), **skip silently** (it's expected dirty data, not an extraction bug). Keep a single aggregate count logged at the end: `[social-insights/${slug}] skipped N cross-platform/none-extractable URLs`.
2. Do not change which rows are queried (platform filter stays); this only changes logging + avoids per-row noise. `extractTargetId` already returns null for these, so no targets are added either way — purely a logging/observability cleanup.

**Acceptance:** No more per-line FB-URL warnings under the IG provider; an aggregate skip count is logged; targets built are unchanged.

---

## Task 4 — Reliable forward window each run (RC-1 depth, forward guarantee)

**Files:** `apps/api/src/services/social-insights/instagram.provider.ts`, `facebook.provider.ts`

**Problem:** Each run must reliably capture the **newest** posts of every account so today/yesterday's submissions are harvested even on firehose accounts. The cron default IG paging is 60 pages (`IG_BACKFILL_MAX_PAGES`), FB 8 (`FB_BACKFILL_MAX_PAGES`), 90d window. For firehose accounts the newest posts are page 1 — already reached — so the forward guarantee is mostly there; the risk is the run NOT completing (Task 2 addresses completion). The remaining lever: ensure the per-run cost is bounded so the run completes within the cycle.

**Change (conservative — bound cost, don't raise it):**
1. Leave the env-overridable caps as-is (don't raise defaults — that would worsen rate-budget pressure).
2. Confirm `loadAccountMedia`/`loadPageFeed` already stop early on the first post older than the window (they do — `sawOlderThanWindow`). No change needed unless verification shows otherwise.
3. Add a brief per-account debug log (gated behind an env flag `INSIGHTS_DEBUG`) of `account → pages paged, posts seen` so a future "why was X not harvested" question is answerable without a code change. Default off (no log spam).

**Acceptance:** No default cap change; early-stop confirmed; optional debug logging available behind `INSIGHTS_DEBUG`.

> NOTE: This task is intentionally minimal — the audit showed the forward newest-window is already reachable (page 1); the real fix for forward reliability is Task 2 (completion) + Task 5 (manual trigger). Keep this task small; do not grind historical depth.

---

## Task 5 — Manual admin refresh endpoint (with status)

**Files:** `apps/api/src/routes/admin-reports.routes.ts` (new route), `apps/api/src/cron/social-insights.cron.ts` + `entity-extraction.cron.ts` (export a guarded run-once + a lightweight in-memory status), `packages/shared` types if needed.

**Problem:** No way to force a refresh; the only lever is a process restart. We want an admin-gated trigger to run harvest + extraction on demand and report progress, used both for verification and for ops.

**Change:**
1. Add a module-level **run-state** singleton (e.g. in a small new `apps/api/src/services/insights-runner.ts`) tracking `{ running: boolean, startedAt, finishedAt, lastResult, lastError, phase }`. `runSocialInsightsRefresh` + `runEntityExtraction` update it. A second concurrent trigger returns "already running" (no double-run).
2. `POST /admin/insights/refresh` (`authenticate` + `requirePermission("reports","view")`): if not already running, kick off `runSocialInsightsRefresh().then(runEntityExtraction)` **in the background** (don't block the request — return 202-style `{ started: true }` immediately) and update run-state. If already running, return `{ started: false, running: true }`.
3. `GET /admin/insights/status`: returns the run-state (running, phase, startedAt, lastResult counts, lastError) so the UI can poll and show progress + any API issue.
4. Errors (e.g. Graph 500/rate-limit) captured into `lastError` and surfaced via status — never thrown to crash the process (the cron already swallows; ensure the runner records them).
5. Keep the existing boot + 6h `setInterval` callers working (they can also update run-state, optional).

**Tests:** route returns 202/`started` shapes; concurrent trigger returns `running:true`; status reflects state. Use the existing route test patterns.

**Acceptance:** Admin can POST to trigger; GET status reflects progress + errors; no double-run; no request blocking.

---

## Task 6 — Frontend: trigger button + honest messaging (UI)

**Files:** `apps/internal/src/app/reports/link-search/page.tsx`, `apps/internal/src/lib/hooks/use-link-search.ts` (or a new small hook), `apps/internal/src/lib/api.ts` usage.

**Problem:** The page has an honest coverage banner but no way to refresh, and no messaging about what enrichment is or what to do when coverage looks low / an API issue occurs.

**Change:**
1. Add a **"Refresh enrichment"** button near the coverage banner that `POST`s `/admin/insights/refresh` and then **polls** `GET /admin/insights/status` every ~3–5s, showing live phase ("Harvesting Instagram & Facebook captions…", "Extracting people & topics…") and a result toast on completion ("Enrichment complete — N new posts searchable").
2. Add a short **explainer** (collapsible or inline subtle text) near the banner: *"Enrichment reads captions from the Instagram & Facebook accounts we manage and tags who's in each post. New posts become searchable within a few hours automatically; use Refresh to pull the latest now. A full pass takes a few minutes."*
3. **API-issue state:** if status returns `lastError` or the trigger fails, show a clear, non-alarming message: *"Couldn't refresh right now (Meta API issue or rate limit). Existing results are unaffected; this resolves automatically — try again in a few minutes."* Never a raw error string.
4. **Honest coverage:** keep the existing per-platform "X searchable of Y submitted · since <date>" banner. Ensure the "since" + the IG/FB historical-limit sentence remain (Meta can't look up old posts by link). Gate any "low coverage" hint on real numbers, not a spinner.
5. Respect existing design tokens (indigo/ink), no new fonts. Button disabled + spinner while running; `aria-live` on the status text.

**Acceptance:** Button triggers + polls + shows phases; explainer present; API-issue message friendly; coverage banner stays honest; `tsc` + build clean.

---

## Task 7 — Docs + CLAUDE.md note

**Files:** `CLAUDE.md` (Internal Portal insights section), the audit + this plan.

**Change:** Add a concise note: IG discovery must use the **bare** `instagram_business_account` field (the `{id}` nested form 500s); the cron isolates providers + always logs `done`; manual trigger at `POST /admin/insights/refresh` + `GET /admin/insights/status`; historical IG/FB ceiling is Meta physics (~1–3% for firehose accounts), forward coverage reliable. No `db:push`.

**Acceptance:** Future readers won't re-introduce the `{id}` form or assume historical backfill is achievable.

---

## Out of scope (per user decision)
- Deep historical backfill (firehose ceiling accepted; banner labels it honestly).
- Opaque FB `/share/` historical recovery (durable fix is submit-time `resolveFacebookShareUrl`, already present; verify it's wired but don't grind the historical tail).
- `report_links.platform` data cleanup (display layer already normalizes; not the cause).
