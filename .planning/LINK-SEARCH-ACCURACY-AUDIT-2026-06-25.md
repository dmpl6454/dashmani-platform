# Link Search Accuracy — End-to-End Audit & Root Cause (2026-06-25)

**Symptom (user-reported):** Link Search shows incomplete IG/FB data. "People posted Ananya Panday links yesterday but search shows only one." Banner: Instagram **1,079 of 40,825** searchable · since 25 Jun; Facebook **1 of 19,324** · since 24 Jun.

**Verdict:** The pipeline is architecturally sound and the cron IS running, but IG/FB enrichment is **under-running, not failing cleanly** — it captures only the small slice of posts that happen to be top-of-feed during the one window a run completes in. Two compounding causes + the known firehose ceiling. **No data was lost; data was never captured.** All findings reproduced live against the prod Meta token (read-only).

---

## The pipeline (forward path, per IG/FB link)

1. Employee submits link → `report_links` row (canonicalKey `ig:<shortcode>` / `fb:<id>`).
2. **social-insights cron** (boot + every 6h): for IG, `buildShortcodeMap()` pages every managed account's `/media` newest-first (90d window, ≤60 pages/acct); `harvestContent()` upserts **every captioned post seen** into `link_content` (status `ok`), keyed by canonicalKey. FB mirrors this with `/published_posts`.
3. **entity-extraction cron** (boot + every 6h, cap 500/run): Haiku reads captions of `status='ok' AND extractedAt IS NULL` rows → `Entity` + `LinkContentEntity` join rows. Idempotent.
4. **search**: resolve entity → its canonicalKeys → bounded prefilter into `report_links` → exact `canonicalKey()` match → group same-vs-unique.

Stages 3 and 4 are healthy (extraction `0 still pending`; search OOM-safe). **The bottleneck is stage 2 — IG/FB content harvest.**

---

## Evidence (prod, 2026-06-25)

### A. The cron runs, but recent runs log ONLY YouTube
```
[social-insights] starting at 2026-06-24T17:41:47Z
[social-insights/youtube] 1942 links → 1941 ok        ← only youtube
[social-insights] starting at 2026-06-24T23:41:47Z    ← next run, no IG/FB summary, no "done in"
... (repeats for 05:41, 05:50)
```
No `[social-insights/instagram]` / `[social-insights/facebook]` summary and **no `[social-insights] done in Xms`** on recent runs → the run does not reliably complete; IG/FB output rotates out of the pm2 buffer or the run is abandoned on restart (`api restarts=16`).

### B. `link_content` (what's actually searchable)
| platform | status | count |
|---|---|---|
| youtube | ok | 1,941 |
| instagram | ok | **1,079** |
| facebook | ok | **1** |
| facebook | not_found | 3,377 |

- All IG/YT rows ARE extracted (`extractedAt` set). Extraction is not the blocker.
- IG enriched timestamps span **6/24 21:22 → 6/25 05:28** only — a single multi-hour run produced all 1,079; nothing since.
- **40,801 distinct IG URLs submitted, 1,079 enriched = 2.6%.**

### C. Ananya Panday specifically
- One `Entity "Ananya Panday" (PERSON)` with **7 join rows** → only ~7 enriched posts mention her, because only 1,079 IG posts total are enriched. Yesterday's 723 IG submissions were mostly never harvested.

### D. Live Graph probes (prod token, read-only)
- **`me/accounts?fields=instagram_business_account` (bare)** → 200, 87 pages, **38 IG accounts**. ✅ (what follower-sync uses)
- **`me/accounts?fields=instagram_business_account{id}`** → **intermittently 500** (one of my probes), 200 on retries. ⚠️ flaky, but when 200 it DOES yield 38 IG nodes (my earlier "0" was a `grep` artifact, not real).
- **`GET /{ig-id}?fields=username,media_count`** → 200. ✅
- **FB discovery `me/accounts?fields=id,access_token,tasks`** → 200, **70 of 87 pages administered**. ✅ FB discovery is unaffected by the `{id}` bug.
- **Full IG paging timing:** 38 accts → **71 Graph calls, 3,730 posts, 79s.** Fine alone, but adds to FB's hundreds of calls under Meta's shared ~200-call/hr budget.
- **Firehose reachability (the hard ceiling):** `creatorspaparazzi` = **10,125** posts, `filmiimemes` = **11,426** posts. Page 1 of 100 reaches back only to **2026-06-20 (5 days)**. 60 pages ≈ 6,000 posts ≈ ~3 weeks. Posts older than that on high-volume accounts are **structurally unreachable** — Meta has no fetch-by-id/shortcode.

---

## Root causes (ranked)

### RC-1 (PRIMARY) — IG/FB harvest doesn't reliably run to completion every cycle; coverage is only "whatever was top-of-feed during the last completed run"
The harvest is the ONLY way IG/FB captions enter `link_content`. It only persisted during one window (6/24 21:22–6/25 05:28). Forward posts (yesterday's Ananya links) are missed unless that exact run caught them at top-of-feed. The run is long (IG 79s + FB hundreds of calls), competes with the 6h timer and app restarts, and shares Meta's rate budget — so completion is not guaranteed.

### RC-2 (SECONDARY, latent) — `discoverIgUserIds()` uses the fragile `{id}` nested expansion
`instagram.provider.ts` requests `instagram_business_account{id}`, which **intermittently 500s**. The sibling `meta-followers.ts` already uses the robust **bare** `instagram_business_account` field (its comment even claims to "mirror discoverIgUserIds" — but they diverged). On a 500, `discoverIgUserIds` does `if (!res.ok) break` → returns `[]` **silently** → that whole run harvests zero IG posts, with no loud log. This makes RC-1 worse and is intermittent/hard to spot.

### RC-3 (HARD LIMIT, not a bug) — firehose historical ceiling ~1–3%
High-volume paparazzi accounts bury old posts beyond any reasonable paging depth. This is Meta-API physics (no fetch-by-id). Forward coverage is fine *if* the harvest runs reliably (RC-1); deep historical coverage is not achievable for these accounts.

### RC-4 (NOISE + minor waste) — dirty `report_links.platform` column
Many FB links are stored under `platform='instagram'`, so the IG provider tries (and fails) to extract shortcodes from `facebook.com/...` URLs, logging thousands of `could not extract targetId` warnings and wasting target-build work. Also one genuinely malformed concatenated URL seen.

---

## Opaque Facebook links (the user's second ask)
- **3,377 FB links are `not_found`**; ~84% of FB links are opaque `facebook.com/share/r/<code>` (a share token, not a post id) → `extractFacebookPostId` returns null → never queryable by the Graph API. Clean `/reel/<numericId>` (~3,123) IS resolvable.
- A **submit-time resolver already exists** (`resolveFacebookShareUrl`, fail-open) to convert `/share/` → clean `/reel/<id>` when fresh. The historical opaque tail (already in the DB as opaque) is largely unrecoverable; the durable fix is submit-time prevention (forward).

---

## Fix options (tradeoffs)

| # | Fix | Effort | Impact | Risk |
|---|---|---|---|---|
| F1 | **RC-2:** switch `discoverIgUserIds()` to the bare `instagram_business_account` field (copy follower-sync); add a loud warning when discovery returns 0 | XS | Removes silent-empty failures; makes IG discovery robust | none (proven path) |
| F2 | **RC-1:** make the cron resilient — run IG/FB **before** YouTube isn't enough; better: decouple providers so one slow/failed provider can't starve another; add per-provider try/catch + always log summary + `done`; add a **manual admin trigger** endpoint to force a refresh on demand | S | Reliable forward coverage; observability | low |
| F3 | **RC-1 depth:** raise IG/FB paging just for the *newest* window so each 6h run reliably captures the last 6–12h of every account (the forward guarantee), independent of historical depth | S | Yesterday's posts reliably captured going forward | low (rate budget) |
| F4 | **RC-4:** in the cron target-build, skip URLs whose host doesn't match the provider (don't feed FB URLs to the IG provider); fix the one malformed URL pattern | XS | Removes log noise, saves work | none |
| F5 | **Opaque FB:** confirm submit-time `resolveFacebookShareUrl` is wired on the HR submit path; optionally a one-time best-effort HEAD-redirect backfill for the historical opaque tail (low yield) | S–M | Forward FB coverage improves; historical tail mostly stays unrecoverable | low (fail-open) |
| F6 | **Honesty:** keep the coverage banner accurate (it already is) — but it currently reads optimistically given RC-1. Ensure "since" + counts reflect reality after fixes | XS | Trust | none |

**Recommended first wave:** F1 + F2 + F4 (low-risk, high-leverage: robust discovery + reliable/observable runs + a manual trigger to immediately re-harvest), then verify a forced run captures yesterday's Ananya posts. F3/F5 as a follow-up. F-firehose (RC-3) is a documented hard limit, not fixable.

**No `db:push` required for F1/F2/F4** (code only). A manual trigger is a new route only.
