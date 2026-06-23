# IG/FB Future-Proofing — Implementation Handoff

> **For the next Claude session.** This is a precise, execute-from-here spec. The hard decisions are made and verified against live prod data — do NOT re-derive or re-litigate them. Read the "Verified facts" section first, then execute the three streams + backfill in order.

**Date:** 2026-06-23
**Status:** Instagram + Facebook are LIVE on prod (token wired, switch flipped, deployed at commit `b953567`). This handoff covers the **remaining future-proofing + the historical backfill**, which were scoped but not yet executed (user chose to checkpoint here).

**Prereq skills:** `superpowers:subagent-driven-development` (or execute inline). Branch off `main` first.

---

## 0. Where things stand (DO NOT REDO)

- **YouTube link-entity-search**: shipped + backfilled (1,917 enriched, 566 entities). Fully working.
- **IG/FB providers**: built (commits `6cba8eb`, `1ed9187`, `e35feca`), **deployed dark then switched ON** — `SUPPORTED_INSIGHT_PLATFORMS = ["youtube","instagram","facebook"]` (commit `f82781e`).
- **Meta token**: a **permanent SYSTEM_USER token** (never expires) is in prod `apps/api/.env` as `META_SYSTEM_USER_TOKEN`, with `META_APP_ID=998903906094758` (Dashmani Insights app) + `META_APP_SECRET`. Verified: 87 Pages, **38 IG accounts** reachable, captions readable.
- **enrich-link-content.ts**: made provider-agnostic (commit `b953567`) — loops `getSupportedSlugs()`, `--platform=<slug>` filter. Ready to backfill IG/FB.
- **The 6h cron is ALREADY enriching IG/FB going forward** (it loops supported slugs). So forward coverage is already happening; this handoff is about (a) deepening the one-time historical catch, (b) the opaque-FB future-proofing, (c) honest UI copy, then (d) running the backfill.

⚠️ **App Secret `a0a0a711e47e97b50fc9ff000f35be2f` was pasted in chat — ROTATE IT** (Dashmani Insights → App settings → Basic → Reset App Secret), then update prod `apps/api/.env` `META_APP_SECRET`. The token itself (the load-bearing credential) was NOT a reset risk, but rotate the secret for hygiene. Note: the App Secret is only used for token-debug/refresh, not for reads, so rotating it won't break enrichment.

---

## Verified facts (measured on prod 2026-06-23 — trust these)

- **The unsolvable limit (IG/FB historical):** the IG/FB Graph API has **no fetch-by-shortcode/share-token**; the only read path is paging an account's `/media` feed newest-first. High-volume accounts (`@pap_feed`, `@filmiimemes`, `@bollywoodshortts`, `@creatorspaparazzi` each hit the 25-page/2,500 cap and were still truncated) bury old posts beyond reach. **Canary measured ~1% historical resolve** (42/4,965) at a 15-page cap across 8 accounts. This is a Meta API design limit, NOT a bug, rate limit, or budget. Scraping is ruled out (ban/ToS/2GB OOM).
- **Forward coverage is HIGH**: fresh posts are top-of-feed → the 6h cron catches them. The gap is purely the historical backlog.
- **Rate limit**: ~200 calls/hr × account count (rolling window), NOT the blocker — canary used ~100 calls. History is unreachable regardless of call budget.
- **Prod link counts**: IG ~36,817 distinct canonicalKeys (39,146 candidates), clean FB `/reel/<n>` ~3,123, opaque FB `/share/r/` ~16,837 (unrecoverable via API).
- **report_links count** baseline ~59,176 (grows from normal submissions — untouched by any backfill).

---

## Decisions (user-confirmed — DO NOT change)

1. **Coverage date in UI**: auto-detected (min enriched `fetched_at` per platform), NOT hardcoded.
2. **Submit-time opaque-FB**: resolve silently, store clean URL; **fail-open, additive, no workflow change** to the load-bearing HR submit path.
3. **Historical IG**: deepen paging to claw back what's reachable (env-overridable), accept the unreachable tail, rely on cron forward.
4. **Opaque FB**: best-effort HEAD-redirect (recover only clean-redirect ones) + submit-time prevention. NO scraping, NO pfbid feed-matching.

---

## STREAM 1 — Deepen IG paging (env-overridable)

**File:** `apps/api/src/services/social-insights/instagram.provider.ts`

Current knobs (top of file): `MEDIA_PAGE_SIZE = 100`, `MAX_PAGES_PER_ACCOUNT = 25`, `POLL_WINDOW_DAYS = 90` (the window early-stops paging).

- [ ] Make both bounds **env-overridable so the cron default is unchanged** but the backfill can page deeper:
  ```ts
  const MAX_PAGES_PER_ACCOUNT = Number(process.env.IG_BACKFILL_MAX_PAGES) || 60;   // was 25
  const POLL_WINDOW_DAYS = Number(process.env.IG_BACKFILL_WINDOW_DAYS) || 90;       // unchanged default
  ```
  (Raise the default cap 25→60 = 6,000 recent media/account — a real dent without absurd volume. The one-time deep backfill sets `IG_BACKFILL_WINDOW_DAYS=1825 IG_BACKFILL_MAX_PAGES=200`.)
- [ ] Do NOT touch the dark-switch, rate-limit handling, injectable graphFetch, or fetchBatch shape. Only the threshold becomes env-driven.
- [ ] Update the header comment to document the env overrides.
- [ ] TEST (`apps/api/tests/meta-providers.test.ts`, mocked graphFetch, no network): with no env set the cap is 60/window 90; a shortcode absent from the mocked feed → `not_found`; dark-safe with no token.
- [ ] `npx tsc --noEmit -p apps/api/tsconfig.json`; `npm run test -w @dashmani/api -- meta-providers`.
- [ ] Commit: `feat(insights): env-overridable IG paging depth for deep historical backfill`.

---

## STREAM 2 — FB opaque resolver wired + submit-time prevention (THE CAREFUL ONE)

**Files:** `apps/api/src/services/social-insights/facebook.provider.ts`, `apps/api/src/services/daily-report.service.ts`

### 2A — provider helper (clean-url-or-null)
- [ ] `resolveOpaqueFacebookUrl(url, fetchImpl=fetch)` already exists (returns a clean numeric **id** or null). Add a thin exported wrapper:
  ```ts
  // Returns a CLEAN canonical FB url (not just the id) if the opaque /share/ link
  // redirects to a clean /reel|/videos/<n>; else null. FAIL-OPEN: any throw/timeout → null.
  export async function resolveFacebookShareUrl(url: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
    try {
      const id = await resolveOpaqueFacebookUrl(url, fetchImpl);  // already fail-open
      return id ? `https://www.facebook.com/reel/${id}` : null;
    } catch { return null; }
  }
  ```
  (If you can cheaply tell reel vs video from the redirect, preserve it; otherwise `/reel/` is fine — canonicalKey only cares about `fb:<id>`.)
- [ ] Leave `fetchBatch` UNCHANGED (clean ids already work; opaque ones never reach it).
- [ ] TEST (injected fetchImpl): clean `/reel` redirect → clean url; `pfbid` redirect → null; non-share url → null; thrown fetch → null (fail-open).

### 2B — submit-time resolution (LOAD-BEARING — additive + fail-open + OUTSIDE the transaction)
`daily-report.service.ts` `submitDailyReport()` builds links via a `linkRows(reportId, now)` helper (~line 221) then `tx.reportLink.createMany(...)` inside a `$transaction` (~line 245-263). Dedupe/canonicalKey runs on the link set.

- [ ] BEFORE the `$transaction` (so a network call never holds a DB tx open), add an additive pass:
  - For each link whose url matches `/facebook\.com\/share\//i` only (touch nothing else), call `resolveFacebookShareUrl(url)` with a short timeout; if it returns a clean url, **replace** `link.url` with it; else leave untouched.
  - Wrap the WHOLE pass in `try/catch` → on any error, proceed with original urls (NEVER throw out of submit).
  - Run resolutions with `Promise.allSettled` + an overall time guard; if a submit has **> 50 opaque links**, skip the excess (log it) so a huge paste never stalls submit.
  - Add a comment block: why fail-open, why before the transaction, why only `/share/`.
- [ ] Dedupe/canonicalKey then runs on the (possibly cleaned) set — desirable (clean urls dedupe better). Do NOT change dedupe logic.
- [ ] TEST: (1) `resolveFacebookShareUrl` as above; (2) submitDailyReport still creates the report with the ORIGINAL url when `resolveFacebookShareUrl` is mocked to throw (fail-open). Do NOT break `daily-report.test.ts`.
- [ ] `npx tsc --noEmit -p apps/api/tsconfig.json`; `npm run test -w @dashmani/api -- daily-report` and `-- meta-providers`.
- [ ] Commit: `feat(fb): best-effort opaque-share resolution at submit time (fail-open) + resolveFacebookShareUrl helper`.

---

## STREAM 3 — Auto-dated coverage banner + honest limitations

**Files:** `apps/api/src/services/link-search.service.ts`, `apps/internal/src/app/reports/link-search/page.tsx`

### 3A — backend: per-platform "since"
- [ ] In `buildCoverage()` (~line 72) add per-platform earliest enriched date. Add `since?: string` to `coverage.byPlatform[slug]` (the `LinkSearchResult.coverage` type ~line 49). Compute as `MIN(link_content.fetched_at) WHERE status='ok'` grouped by platform — ONE cheap query (prisma `groupBy` with `_min: { fetchedAt: true }`, `by: ['platform']`, `where: { status: 'ok' }`). Keep all existing fields unchanged (additive).
- [ ] TEST (`link-search.test.ts`): seed a `link_content` row (status ok, known `fetched_at`), assert `coverage.byPlatform[platform].since` matches.

### 3B — UI: replace the hardcoded "pending Meta API" copy
The banner (~line 141-155) currently hardcodes *"Instagram & Facebook enrichment is pending Meta API access — counts will grow…"*. Replace with accurate, auto-derived copy:
- [ ] Keep "Searching N of M enriched links".
- [ ] Add a **limitations** note (concise, honest):
  - **YouTube**: fully searchable (no date limit).
  - **Instagram & Facebook**: searchable for posts published **on/after `<coverage.byPlatform.instagram.since formatted e.g. "23 Jun 2026">`**; older posts only partially available because Instagram/Facebook don't allow looking up old posts by link.
  - **Opaque `facebook.com/share/` links** can't be matched.
- [ ] Gate gracefully: if a platform has no `since` (no enriched rows) omit its line; don't crash if `byPlatform`/`since` missing (older API responses). Format date with `toLocaleDateString("en-IN", {day:"numeric",month:"short",year:"numeric"})`.
- [ ] `npx tsc --noEmit -p apps/api/tsconfig.json` AND `-p apps/internal/tsconfig.json`.
- [ ] Commit: `feat(link-search): auto-dated per-platform coverage + honest IG/FB limitations in UI`.

---

## Safety gates (the user's hard constraint: don't break anything, esp. submit)

Before merge, an adversarial pass MUST confirm:
1. **submitDailyReport is fail-open** — the `/share/` resolution is wrapped so it can never throw/block/slow submit; quote the try/catch.
2. **Resolution is OUTSIDE the `$transaction`** — no network call holds a DB tx open.
3. **No link loss** — resolution only REPLACES an opaque url with a clean one; never drops/reorders/merges links; dedupe runs on the cleaned set without loss.
4. **Dark-safe** — with no `META_SYSTEM_USER_TOKEN`, `resolveFacebookShareUrl` returns null and submit is unaffected.
5. **Cron defaults unchanged** — no `IG_BACKFILL_*` env → IG paging is exactly today's behavior.
6. **tsc clean** (api + internal), **full `npm run build` 5/5 apps**, pre-existing test-failure count not increased.
7. **UI crash-safe** if `coverage.byPlatform.since` missing.

Then: full `npm run build` (kill dev servers first), merge to main, deploy (auto), `pm2 restart api` so env reloads.

---

## STREAM 4 — Run the backfill (after deploy)

On prod (`ssh linode`), source the env so the provider has the token + deep-paging overrides:

```bash
ssh linode
cd /opt/dashmani-platform
# Deep one-time IG historical backfill (env overrides widen the paging just for this run):
export $(grep -E '^(META_SYSTEM_USER_TOKEN|META_APP_ID|META_APP_SECRET|YOUTUBE_API_KEY)=' apps/api/.env | xargs)
export IG_BACKFILL_WINDOW_DAYS=1825 IG_BACKFILL_MAX_PAGES=200
cd packages/db
# DRY-RUN first (counts only):
npx tsx ../../scripts/enrich-link-content.ts --platform=instagram
# APPLY (resolves the reachable recent subset — expect a few thousand, NOT 36k; that's the API limit):
npx tsx ../../scripts/enrich-link-content.ts --platform=instagram --apply
# Clean Facebook:
npx tsx ../../scripts/enrich-link-content.ts --platform=facebook --apply
# Then extract entities for the newly-enriched captions (ANTHROPIC_API_KEY from apps/api/.env):
npx tsx ../../scripts/extract-entities.ts --apply --confirm-prod
```
- [ ] Report enriched vs not_found counts (not_found = old/unreachable — expected and honest).
- [ ] Verify a live search now returns Instagram results: `POST /v1/auth/login` (tabish@dashmani.com / admin@123) → `GET /v1/admin/link-search?q=<a celeb seen in IG captions, e.g. "Nita Ambani">` and confirm IG posts appear + the coverage banner shows the "since" date.

---

## What "done + future-proof" means here (set expectations honestly)
- **Forward**: IG/FB links submitted from go-live onward enrich automatically (cron) + opaque FB links get cleaned at submit → FB coverage stops bleeding.
- **Historical**: the reachable recent subset is captured; the deep tail is permanently unreachable via sanctioned APIs (the UI says so).
- **YouTube**: fully covered, no limitation.
- **Opaque FB historical (~16.8k)**: largely unrecoverable; UI is honest about it; the submit-time fix prevents *new* ones.
