# Account-Growth Accuracy (PR-A) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Recover follower counts for the ~164 currently-unsynced-but-recoverable social accounts (FB numeric-ID pages ≈ 9.85M followers, X/Twitter accounts), add an admin kill-switch for the credit-burning LLM enrichment, and archive only the 5 genuinely-dead FB accounts — so the Account Growth number reflects reality before the CEO dashboard is built on top of it.

**Architecture:** All work is additive/fail-open, extends the existing `follower-sync.service.ts` Tier-1/Tier-3 pattern, and follows the codebase's hard rule: **live-probe every Graph/scraper fetcher against the real token from the Linode IP — mocks cannot catch field-shape/rotation lies.** No `db:push` (the `system_settings` table already exists in prod). Everything is guarded so a failure keeps the prior value and never crashes the cron.

**Tech Stack:** TypeScript, Express, Prisma, Vitest. Node global `fetch`. Prod is a 2GB Linode; the follower-sync cron shares a ~200-call/hr Meta budget with the harvest cron.

---

## Context you MUST read first

- `apps/api/src/services/follower-sync.service.ts` — the whole follower-sync engine. Study `fetchFacebookFollowers()` (lines 195–236), the Tier-1/Tier-3 structure in `syncAllFollowerCounts()`, and `persistFollowerCount()` (the single write path with the `>0` guard + IST snapshot).
- `apps/api/src/cron/entity-extraction.cron.ts` — `runEntityExtraction()`; the kill-switch gates the top of this.
- `apps/api/src/cron/social-insights.cron.ts` lines 71 + 104 + 379 — the `prisma.systemSetting.findUnique/upsert` pattern to copy for the toggle.
- `apps/api/src/routes/admin-reports.routes.ts` lines 550–570 — the existing `POST /admin/insights/refresh` + `GET /admin/insights/status` (pattern for adding the toggle endpoints, `requirePermission("reports","view")`).
- CLAUDE.md → the follower-accuracy + Snapchat + FB-scraper sections. **Non-negotiable rules:** never re-introduce `instagram_business_account{id}` nested form; never raise `IG_TIER3_MAX_HANDLES` without re-checking the Meta budget; always live-verify from the Linode IP; fail-open is mandatory (a miss keeps the prior value, never writes 0).

## Live-verified facts this plan is built on (2026-07-10, from Linode IP)

- **FB numeric-ID path WORKS:** `GET https://m.facebook.com/profile.php?id=<n>&locale=en_US` + **mobile Safari UA** → ~45KB un-walled page; `og:description` = `"Name. N,NNN likes · …"`. Tested 150/155 real prod stubs resolve, 9.85M followers total.
- **FB vanity-slug WALLED:** every www/m/mbasic surface + all UAs 302 to `/login` for slugs. No unauthenticated path. Graph API returns `code:100/subcode:33` (needs App Review + PPCA). → manual only.
- **X/Twitter guest-token WORKS:** `POST https://api.twitter.com/1.1/guest/activate.json` (public web bearer) → `UserByScreenName` GraphQL (query id `G3KGOASz96M-Qu0nwmGXNg`) → `data.user.result.legacy.followers_count`. 7/8 resolve, stable, rate-limit 150/token. `MovifiedTamil` is a dead handle (manual URL fix). ⚠️ bearer + query-id rotate — live-probe if it breaks.
- **Snapchat 3 DEAD:** expired share tokens, no `/p/<uuid>` path. Scraper code is correct. Manual URL fix only.
- **The 156 "numeric-name" FB accounts are NOT junk** — they're real pages that were never synced. Only **5** are genuinely dead (no count anywhere). Archive ONLY those 5.

---

## Task 1: FB numeric-ID follower recovery

**Files:**
- Modify: `apps/api/src/services/follower-sync.service.ts` — `fetchFacebookFollowers()` (195–236)
- Test: `apps/api/tests/follower-sync.test.ts` (create if absent; otherwise add cases)

**Step 1 — Write the failing test.** Assert that for a numeric-ID URL the function fetches `m.facebook.com/profile.php?id=<n>&locale=en_US` with a mobile Safari UA and parses `"Comedy Park. 1,000,000 likes · …"` → `1000000`; and that a vanity-slug URL still uses the existing `www.facebook.com/<slug>` Googlebot path. Mock `fetch` to return a canned og:description per URL; assert the requested URL + UA.

**Step 2 — Run it, verify it fails** (`npm run test -w @dashmani/api -- follower-sync`).

**Step 3 — Implement.** Add a numeric-ID branch at the top of `fetchFacebookFollowers()`:
```ts
// Numeric-ID pages (profile.php?id=<n>) are served UN-WALLED by the lightweight
// mobile site; www/desktop now returns a login wall for these. Live-verified
// 2026-07-10 from the Linode IP: 150/155 real prod pages resolved. The vanity-slug
// path below stays as-is (still works for the pages FB doesn't wall).
const numericId = (profileUrl.match(/profile\.php\?id=(\d+)/) || [])[1];
if (numericId) {
  const html = await fetchPageHtml(
    `https://m.facebook.com/profile.php?id=${numericId}&locale=en_US`,
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
  );
  if (html) {
    const ogDesc = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
    if (ogDesc) {
      const decoded = devanagariToAscii(decodeHtmlEntities(ogDesc[1]));
      // "Name. 1,000,000 likes · …" — grab the number BEFORE likes/followers,
      // not the name if the name contains digits.
      const m = decoded.match(/([\d,]+)\s*(?:likes|followers|people)/i) || decoded.match(/([\d,]+)/);
      if (m) {
        const parsed = parseFollowerCount(m[1]);
        if (parsed && parsed > 0) return parsed;
      }
    }
  }
  // fall through to the slug path as a last resort (harmless; usually also null)
}
```
Keep everything below unchanged (the slug path is the fallback). Preserve fail-open (return null → caller keeps prior value).

**Step 4 — Run tests, verify pass.**

**Step 5 — Commit** `feat(follower-sync): recover FB numeric-ID page followers via un-walled mobile path`.

---

## Task 2: X/Twitter follower resolver (Tier-3)

**Files:**
- Create: `apps/api/src/services/social-insights/twitter-followers.ts`
- Modify: `apps/api/src/services/follower-sync.service.ts` — add an `unresolvedTw` bucket + a Tier-3 pass mirroring the YouTube one; add a `slug === "x"` branch in the first-pass loop that pushes to `unresolvedTw` (X has no Tier-1 map).
- Test: `apps/api/tests/twitter-followers.test.ts`

**Step 1 — Write the failing test** for a pure `parseTwitterFollowers(json)` that extracts `data.user.result.legacy.followers_count` and returns null for the empty `{"data":{}}` (dead handle) shape and when a soft `errors[]` is present but the count is populated (return the count).

**Step 2 — Run, verify fail.**

**Step 3 — Implement `twitter-followers.ts`:**
- `fetchTwitterFollowerMap(handles: string[]): Promise<Map<string, number>>` — activate ONE guest token per run (`POST https://api.twitter.com/1.1/guest/activate.json` with `Authorization: Bearer <PUBLIC_WEB_BEARER>`), reuse it across all handles, `GET` the `UserByScreenName` GraphQL endpoint per handle, parse via the pure `parseTwitterFollowers`. Fail-open on 429/timeout (return partial map). Per-account `console.log` (follower-sync convention). Constants (bearer, query id) at top with a ⚠️ comment that they rotate and must be live-probed. `TWITTER_FOLLOWER_SYNC_ENABLED=0` kill switch.
- Route it as Tier-3 in `syncAllFollowerCounts()`: after the YT Tier-3 block, `if (unresolvedTw.length) { try { map = await fetchTwitterFollowerMap(handles); for (acct of unresolvedTw) { entry ? persistFollowerCount : progress.failed++ } } catch { progress.failed += unresolvedTw.length } }`.
- First-pass loop: add `else if (slug === "x") { /* no Tier-1 map; defer to Tier-3 */ }` then the existing `followers === null` collector pushes to `unresolvedTw`.

**Step 4 — Run tests, verify pass.**

**Step 5 — Commit** `feat(follower-sync): X/Twitter follower resolver via guest-token GraphQL (fail-open)`.

---

## Task 3: Enrichment kill-switch (LLM extraction only)

**Files:**
- Modify: `apps/api/src/cron/entity-extraction.cron.ts` — early-return when disabled.
- Modify: `apps/api/src/routes/admin-reports.routes.ts` — add `GET /admin/enrichment/toggle` + `PUT /admin/enrichment/toggle` (`requirePermission("reports","view")` for GET; keep PUT on the same permission the page already uses).
- Modify: `apps/internal/src/app/api-costs/page.tsx` — add a toggle switch calling the endpoints.
- Test: `apps/api/tests/entity-extraction-toggle.test.ts`

**Design:** `system_settings` key `enrichment.enabled`, value `"true"` / `"false"`. Default = ON (absent key ⇒ enabled) so behavior is unchanged until an admin flips it off.

**Step 1 — Write the failing test:** `runEntityExtraction()` early-returns (no `findMany`, no LLM call) when `system_settings['enrichment.enabled'] === 'false'`; runs normally when absent or `'true'`.

**Step 2 — Run, verify fail.**

**Step 3 — Implement.** At the top of `runEntityExtraction()`, after the provider check:
```ts
const toggle = await prisma.systemSetting.findUnique({ where: { key: "enrichment.enabled" } });
if (toggle?.value === "false") {
  console.log("[entity-extraction] disabled by admin toggle (enrichment.enabled=false) — skipping run");
  return;
}
```
Add the two routes (GET reads the key, defaults `true`; PUT upserts `"true"`/`"false"`). Add the toggle UI on `/api-costs` (a labelled switch: "Caption enrichment (LLM entity tagging)" with a note "Off = stop paid LLM calls; harvesting + follower sync + engagement keep running").

**Step 4 — Run tests, verify pass.**

**Step 5 — Commit** `feat(enrichment): admin kill-switch for LLM entity-extraction (system_settings)`.

---

## Task 4: Archive ONLY the 5 dead FB accounts

**Files:**
- Create: `scripts/archive-dead-fb-accounts.ts` (dry-run default; `--apply --confirm-prod`; reversible `status` flip to `INACTIVE`, NEVER delete).

**The 5 dead IDs** (from the 2026-07-10 recovery test — no follower count resolvable anywhere): `61569870441299, 61571952268643, 61588529114648, 61581310762918, 61587015153792`.

**Design:** The script re-verifies each of the 5 is STILL zero-follower + zero-links + returns no count via the mobile path (belt-and-suspenders — a page may have come alive), and only then flips `status` to `INACTIVE`. Prints exactly what it will change; requires both flags to write. Idempotent.

**Step 1 — Write the script** with the dry-run guard.
**Step 2 — Run dry-run locally against prod DB** (read-only), confirm it targets exactly 5 rows.
**Step 3 — Commit** `chore(accounts): script to archive 5 verified-dead FB accounts (reversible)`. (Actual `--apply` on prod happens in the verification phase, with the user watching.)

---

## Task 5: Full verification (build + tests + LIVE prod probe)

**This is the load-bearing step — the codebase rule is that Graph/scraper fixes MUST be verified live, not just by build/tests.**

**Step 1** — `npx tsc --noEmit` across api + shared; `npm run test -w @dashmani/api` (all green, note any PRE-EXISTING failures separately — do not claim to have fixed them).
**Step 2** — Full `npm run build` (all apps) — the api-costs page change must not break the internal build.
**Step 3 — LIVE prod probe** (read-only, from Linode) BEFORE merge: run the FB mobile path + X guest-token against a handful of real prod accounts and confirm real counts come back. This is how the `limit=100`→500 class of bug is caught.
**Step 4** — After merge + deploy: manually trigger a follower sync on prod, watch the logs for `[follower-sync] facebook/... : <n>` and `[follower-sync] x/...: <n>` lines, then re-query the DB to confirm `last_synced_at` populated + `account_growth_snapshots` written for the recovered accounts. Confirm the growth total rose by ~9.85M+ and the LIVE/MANUAL split improved.
**Step 5** — Flip the enrichment toggle off on prod, confirm the next extraction run logs the "disabled by admin toggle" line and spends nothing; flip back on.

---

## Non-goals / do NOT touch
- The daily-report submit transaction, the rbac asyncHandler guard, the connection-pool fix, the getReportSummary groupBy — all load-bearing incident fixes, leave untouched.
- IG Tier-3 cap (leave at 30 — user decision).
- The 156 real FB accounts — DO NOT archive; Task 1 recovers them.
- No `db:push` (system_settings exists; no schema change).
- The 12 walled FB slugs + 3 Snapchat + MovifiedTamil → hand the user a manual-fix list; no code.
