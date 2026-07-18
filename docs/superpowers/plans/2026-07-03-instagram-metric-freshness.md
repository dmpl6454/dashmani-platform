# Instagram (and Facebook) Metric Freshness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Instagram (and Facebook) engagement metrics on the internal `/reports` "Top Links" panels refresh within days instead of weeks, and stop the UI from promising a "every 6h" cadence the system cannot meet — without re-starving Facebook or blowing the shared Meta rate budget.

**Architecture:** The insights metric sweep is a single sequential provider loop (`youtube → facebook → instagram`) bounded by a per-provider wall-clock budget (`SWEEP_BUDGET_MS`, default 25 min) plus a resume cursor. Investigation proved IG is **not** rate-limited (0 errors, ~40-65 ok every run); the real bottleneck is **throughput**: IG spends its entire 25-min budget in `buildShortcodeMap()` (paging ~15,651 captions) *before polling a single link*, then yields having polled only ~350 of 35,520 links → a ~25-day refresh cycle. The fix is two independent, low-blast-radius changes: (1) **decouple the budget clock from the one-time map-build** so the polling window is the full budget, and raise cadence + budget via env so the IG/FB cursor cycles the tail in ~2-4 days; (2) **surface the real `fetchedAt`** on the panels ("Updated Xh ago") and drop the false "updates every 6h" promise. No schema change. No read-path filter change. The `igRateLimited` short-circuit, the sequential loop, the FB-starvation budget guard, the early-harvest, and the `status="ok"` read filter are all **preserved**.

**Tech Stack:** Node/Express + Prisma (apps/api), in-process `setInterval` crons (apps/api/src/index.ts), Next.js App Router + SWR (apps/internal), Vitest (apps/api tests).

---

## Root-Cause Evidence (do not re-investigate — this is settled)

Verified live against prod (Linode, 2026-07-03) — record so the implementer doesn't repeat the work:

- **IG is NOT rate-limited.** Every recent run: `[social-insights/instagram] 35520 links → 300 polled, 41 ok, 259 not_found, 0 errors`. The only "rate limited" logs are `[follower-sync] Instagram rate limited …` — a *different* code path (follower-sync's own `igRateLimited`, not the provider's). The audit's `igRateLimited`-short-circuit hypothesis is **refuted**.
- **The bottleneck is the one-time map build, not polling.** Log line-number gaps show IG's `harvested …` and `metric-sweep budget … yielding` lines are adjacent (same instant) — IG yields on budget *immediately after* the harvest, having polled only ~350 links. `buildShortcodeMap()` (paging ~15,651 captions across managed accounts) consumes the whole 25-min budget before `fetchBatch` returns its first batch. `INSIGHTS_DEBUG` paging lines (186 of them) confirm deep per-account paging.
- **The staleness is real and severe.** `link_metrics` latest-`ok`-per-link age distribution (prod): IG = 52 fresh (<6h), 3,466 in the 7-30d bucket (oldest latest-ok 2026-06-24, 9 days). FB = 199 <6h, 9,793 in 1-7d. YouTube = 2,696 of 2,699 <6h (fits one budget window → truly fresh). **Facebook has the identical latent bug** — it only *looked* fresh to the audit because the queried top-20 FB links happened to sit in the recently-swept cursor window.
- **Read path shows the last good snapshot.** Every read (`getTopLinksByPlatform`, `getInsightsSummary`) filters `status="ok"`, latest-per-link by `fetchedAt DESC`. So `rate_limited`/`not_found` rows never overwrite the display — the panel shows the last `ok` snapshot's stale `fetchedAt`, with no staleness signal. Data is *correct*, just old.
- **Budget is genuinely tight.** follower-sync (hourly, ~40-71 Meta calls/run) hit Graph rate-limit 766× in the log window; ig-caption-backfill (hourly, up to ~124 calls/run) shares the same ~200-call/hr Meta budget. FB scraper error spikes (2,200 / 9,000 errors on some runs) are real and periodic. **Cadence must be raised carefully** — see the constraints below.

## Hard Constraints (the "don't sabotage anything" list)

1. **Preserve `igRateLimited` + `fbRateLimited` short-circuits.** They are correct defense — leave them.
2. **Preserve the sequential provider loop + per-provider budget.** The budget was added 2026-06-26 specifically to stop IG starving Facebook. Do NOT remove it; do NOT reorder providers (`youtube, facebook, instagram` — IG must stay last).
3. **Preserve the early-harvest and its `harvestedThisRun` gating.** Link Search depends on it; it must still fire before any budget yield.
4. **Preserve the `status="ok"` read-path filter and JS latest-per-link dedupe.** Do not touch `getTopLinksByPlatform` / `getInsightsSummary` selection logic.
5. **Do not raise Meta call volume unsafely.** The map build pages the *same managed accounts* regardless of run frequency, so each extra run costs another full map-build's worth of Meta calls. Cadence increase is bounded (see Task 2 sizing) and gated so it never collectively pushes past ~200 calls/hr alongside follower-sync + backfill.
6. **Be conservative with Facebook cadence specifically.** More frequent runs = more FB public-reel scraper hits from the datacenter IP = more block risk. The FB scraper is already politeness/short-circuit guarded (`FB_SCRAPER_DELAY_MS`, `FB_SCRAPER_WALL_LIMIT`); do not weaken those.
7. **No `db:push`.** No schema change is required or permitted by this plan.
8. **Verify LIVE on prod after deploy** (per CLAUDE.md convention for cron/Graph fixes) — build + tests green is necessary but NOT sufficient.

---

## File Structure

- **Modify** `apps/api/src/cron/social-insights.cron.ts` — decouple the metric-sweep budget clock from the one-time map/harvest phase so the budget bounds *polling*, not map-build (Task 1). Add optional `INSIGHTS_METRIC_BUDGET_MS` knob.
- **Modify** `apps/api/src/index.ts` — make the insights cron interval env-configurable (`INSIGHTS_INTERVAL_MS`, default unchanged at 6h) so prod can raise cadence without a code change (Task 2).
- **Modify** `apps/api/.env` on prod (documented, not committed — `.env` is gitignored) — set the tuned `INSIGHTS_INTERVAL_MS` + budget values (Task 2, deploy step).
- **Modify** `apps/internal/src/app/reports/page.tsx` — derive "Updated Xh ago" from the panel's own row `fetchedAt` and correct the three `note` strings (Task 3).
- **Test** `apps/api/tests/social-insights-cron.test.ts` (new or existing) — cover the budget-clock decoupling (Task 1).

No new files besides possibly the test. Types unchanged (the panels already receive `fetchedAt` per row).

---

## Task 1: Decouple the metric-sweep budget clock from the one-time map/harvest build

**Why:** Today `slugDeadline = Date.now() + SWEEP_BUDGET_MS` is set *before* the first `fetchBatch` call, which for IG blocks ~25 min inside `buildShortcodeMap()`. By the time the first batch returns, the budget is already spent, so IG polls one batch and yields. If we (re)start the budget clock **after the early harvest fires** (i.e. after the map is built once and cached), the full budget is spent *polling links against the cached map*, which is the cheap part. This alone multiplies IG links-polled-per-run by roughly the ratio (polling_time / total_time) — a large win with zero cadence change.

**Files:**
- Modify: `apps/api/src/cron/social-insights.cron.ts:199-211` (deadline init) and `:296-359` (the post-batch budget checks).
- Test: `apps/api/tests/social-insights-cron.test.ts`

- [ ] **Step 1: Write the failing test**

Create or extend `apps/api/tests/social-insights-cron.test.ts`. The test must prove: when the first batch is slow (simulating map-build) but subsequent batches are fast, the sweep polls MANY batches, not just one, because the budget clock starts after the harvest — not before the map build.

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We test the budget-clock behavior at the seam we can control: the provider's
// fetchBatch timing + Date.now(). The cron reads Date.now() to compute the deadline;
// we make the FIRST fetchBatch "cost" ~26 min of wall-clock (via a mocked clock) to
// simulate the map build, then assert the sweep still processes multiple later batches.

describe("social-insights cron — metric budget clock starts after harvest, not before map build", () => {
  let now = 0;
  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });
  afterEach(() => vi.restoreAllMocks());

  it("does not exhaust the budget on the map-build phase — polls multiple batches after harvest", async () => {
    // Arrange a fake provider: first fetchBatch advances the clock by 26 min
    // (the map build), and fires harvest; later batches are instant.
    const METRIC_BUDGET_MS = 25 * 60 * 1000;
    let batchCalls = 0;
    let harvestFlushedAtCall = -1;

    const fakeProvider = {
      slug: "instagram",
      isSupported: () => true,
      extractTargetId: (u: string) => u, // treat url as its own id
      fetchBatch: vi.fn(async (batch: any[]) => {
        batchCalls++;
        if (batchCalls === 1) now += 26 * 60 * 1000; // simulate the 26-min map build
        const m = new Map();
        for (const t of batch) m.set(t.linkId, { ok: true, status: "ok", views: 1, likes: 1, comments: 1, shares: null, title: null, caption: "c" });
        return m;
      }),
      harvestContent: vi.fn(() => {
        harvestFlushedAtCall = batchCalls;
        return [{ canonicalKey: "ig:abc", caption: "c", title: null }];
      }),
    };

    // The cron must NOT stop after batch 1. With the OLD code (deadline set before the
    // first fetchBatch), the 26-min jump on batch 1 would trip the deadline and the loop
    // would break after batch 1. With the FIX (deadline (re)based after harvest fired),
    // the many small later batches all run within budget.
    //
    // Drive the loop with >2 batches of targets and assert fetchBatch ran for all of them.

    // NOTE: The exact harness for invoking the sweep loop in isolation depends on how
    // this test file already stubs prisma + the provider registry. Follow the existing
    // pattern in apps/api/tests/meta-providers.test.ts / social-insights*.test.ts for
    // mocking `@dashmani/db` (prisma.linkMetric.create, systemSetting.*) and
    // getSupportedSlugs()/getProvider(). Provide, say, 5 batches × 50 targets = 250 links.

    // Assert: after the fix, all 5 batches are fetched (batchCalls === 5), and harvest
    // fired on the first batch (harvestFlushedAtCall === 1).
    expect(harvestFlushedAtCall).toBe(1);
    expect(batchCalls).toBeGreaterThanOrEqual(5);
  });
});
```

> **Implementer note:** wire the mocks to match the existing cron test setup in this repo (search `apps/api/tests` for how `runSocialInsightsRefresh` or the provider registry is currently mocked; `meta-providers.test.ts` mocks `graphFetch`, and there should be a prisma mock helper under `apps/api/tests/`). The behavioral assertion is what matters: **batch 1's clock jump must not end the sweep.**

- [ ] **Step 2: Run the test to verify it FAILS against current code**

Run: `npm run test -w @dashmani/api -- social-insights-cron`
Expected: FAIL — with the current code the deadline is set before batch 1, so the 26-min jump on batch 1 trips `Date.now() > slugDeadline` and the loop breaks after batch 1 (`batchCalls === 1`), failing `expect(batchCalls).toBeGreaterThanOrEqual(5)`.

- [ ] **Step 3: Implement the budget-clock decoupling**

In `apps/api/src/cron/social-insights.cron.ts`:

3a. Add the metric-budget knob near the top (after `SWEEP_BUDGET_MS`, line ~11):

```typescript
// The metric-sweep budget bounds the PER-LINK POLLING phase, measured from the moment
// the early harvest fires (i.e. after the one-time feed-map build). WHY separate from
// SWEEP_BUDGET_MS: for owned-feed providers (IG/FB) the map build can itself consume
// tens of minutes; if the budget clock includes it, the provider yields having polled
// almost nothing (the 2026-07-03 IG "~25-day refresh cycle" bug). Defaults to
// SWEEP_BUDGET_MS so behavior is unchanged unless explicitly tuned in prod .env.
const METRIC_BUDGET_MS = Number(process.env.INSIGHTS_METRIC_BUDGET_MS) || SWEEP_BUDGET_MS;
```

3b. Change the deadline from a fixed pre-loop value to one that (re)bases when the harvest fires. Replace the current fixed init (line ~211):

```typescript
      const slugDeadline = Date.now() + SWEEP_BUDGET_MS;
```

with a mutable deadline seeded generously for the map-build phase, rebased after harvest:

```typescript
      // Deadline for THIS provider's metric sweep. It is (re)based to
      // now + METRIC_BUDGET_MS the moment the early harvest fires — so the budget bounds
      // the cheap per-link polling phase, NOT the one-time map build that precedes it.
      // Until then it sits far in the future so the map-build batch can't trip it. The
      // HARD backstop below (2×) still fires on Date.now() to protect the never-harvests
      // case (e.g. IG discovery returns 0 accounts → empty map → harvest never fires).
      let slugDeadline = Number.MAX_SAFE_INTEGER;
      const runStartedForSlug = Date.now();
```

3c. When the early harvest fires (inside the `if (!harvestedThisRun && ... harvestContent ...)` block, right after `if (harvested.length > 0) harvestedThisRun = true;` at line ~325), rebase the deadline:

```typescript
              if (harvested.length > 0) {
                harvestedThisRun = true;
                // Rebase the metric-sweep budget to start NOW — the map is built + cached,
                // so the remaining batches are cheap map lookups. This is the fix for the
                // IG "map build eats the whole budget → ~1 batch polled" starvation.
                slugDeadline = Date.now() + METRIC_BUDGET_MS;
              }
```

(Remove the old bare `if (harvested.length > 0) harvestedThisRun = true;` line — it is replaced by the block above.)

3d. Fix the HARD backstop so it measures from the run start (not the now-far-future `slugDeadline`). Replace the HARD backstop check (line ~353):

```typescript
          if (Date.now() > slugDeadline + SWEEP_BUDGET_MS) {
```

with a run-start-relative guard that still triggers when harvest never fired:

```typescript
          // HARD backstop: if the early harvest NEVER fired (empty map), slugDeadline is
          // still MAX_SAFE_INTEGER, so the soft budget check above can't trigger. Bound the
          // whole provider (map-build + polling) at 2× METRIC_BUDGET_MS from run start so a
          // non-harvesting provider can't grind forever and starve later providers.
          if (Date.now() > runStartedForSlug + 2 * METRIC_BUDGET_MS) {
```

Leave the soft budget check (`if (harvestedThisRun && Date.now() > slugDeadline)`, line ~341) exactly as-is — it now correctly measures polling time only, because `slugDeadline` is rebased at harvest.

- [ ] **Step 4: Run the test to verify it PASSES**

Run: `npm run test -w @dashmani/api -- social-insights-cron`
Expected: PASS — batch 1's 26-min jump happens *before* the deadline is rebased, so it doesn't end the loop; the deadline rebases at harvest (call 1), and the fast later batches all run within `METRIC_BUDGET_MS` → `batchCalls >= 5`, `harvestFlushedAtCall === 1`.

- [ ] **Step 5: Run the full api test suite to confirm no regressions**

Run: `npm run test -w @dashmani/api`
Expected: All previously-passing suites still pass. (Note: per memory `project_reports_extract_spreadsheet`, ~36 pre-existing API test failures unrelated to this change may exist in content/analytics/task/team setup — confirm your change adds no NEW failures beyond that known baseline. If unsure, run `git stash`, capture the baseline pass/fail list, `git stash pop`, and diff.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/cron/social-insights.cron.ts apps/api/tests/social-insights-cron.test.ts
git commit -m "fix(insights): metric-sweep budget bounds polling, not the one-time map build

IG spent its entire 25-min per-provider budget inside buildShortcodeMap()
before polling a single link, yielding after ~350 of 35,520 links → a ~25-day
refresh cycle. Rebase the budget clock to start when the early harvest fires
(map built + cached), so the budget bounds the cheap per-link polling phase.
FB has the same latent bug and benefits identically. Sequential loop, provider
order, igRateLimited short-circuit, early-harvest gating, and read path all
preserved. No schema change.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Make the insights cron cadence env-configurable and tune it on prod

**Why:** Task 1 makes each run poll far more links, but a 35,520-link IG tail still won't fully cycle in one run. Raising cadence multiplies coverage. It MUST be env-driven (no code change to re-tune) and bounded so the extra map-builds don't collectively blow the ~200-call/hr Meta budget shared with follower-sync (hourly) + ig-caption-backfill (hourly). Sizing below.

**Sizing (do the math, don't guess):**
- Each insights run does ~1 IG map-build (~38 accounts × up to 8 pages ≈ up to ~300 Meta calls, but typically far fewer since paging stops at the 21-day window edge — logs show the build completing) + ~1 FB map-build. Follower-sync alone can use ~40-71 Meta calls/hr; backfill up to ~124/hr. **A safe target is insights running no more often than every ~2h** so it contends with at most ~1 follower-sync + ~1 backfill per window, staying comfortably under ~200/hr in aggregate.
- At **2h cadence (12 runs/day)** with Task 1's higher per-run polling: even a conservative ~1,500 IG links/run (up from ~350) × 12 = ~18k/day → IG's 35,520 tail cycles in **~2 days** (down from ~25). FB's ~11k cycles in well under a day. This meets "refresh within days".
- Do NOT go below 2h without re-measuring Meta call volume live (constraint 5/6). Facebook scraper block-risk is the binding limit, not IG.

**Files:**
- Modify: `apps/api/src/index.ts:20-25` (insights interval).
- Modify (prod, uncommitted): `apps/api/.env`.

- [ ] **Step 1: Make the interval env-configurable in `apps/api/src/index.ts`**

Replace the insights block (lines 20-25):

```typescript
  // Run social insights refresh once on startup, then every 6 hours
  const runInsights = () => {
    runSocialInsightsRefresh().catch((err) => console.error("[social-insights] error:", err));
  };
  runInsights();
  setInterval(runInsights, 6 * 60 * 60 * 1000);
```

with:

```typescript
  // Run social insights refresh once on startup, then on INSIGHTS_INTERVAL_MS (default
  // 6h, unchanged). Prod raises cadence via .env (e.g. 2h) to shrink the IG/FB per-link
  // refresh latency — the metric sweep is cursor-based, so more runs cover more of the
  // ~35k IG / ~11k FB tail per day. Bounded ≥2h in practice to stay under the shared
  // ~200-call/hr Meta budget (follower-sync + ig-caption-backfill also draw from it) and
  // to keep the Facebook public-reel scraper polite. See the 2026-07-03 freshness plan.
  const INSIGHTS_INTERVAL_MS = Number(process.env.INSIGHTS_INTERVAL_MS) || 6 * 60 * 60 * 1000;
  const runInsights = () => {
    runSocialInsightsRefresh().catch((err) => console.error("[social-insights] error:", err));
  };
  runInsights();
  setInterval(runInsights, INSIGHTS_INTERVAL_MS);
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Commit the code change**

```bash
git add apps/api/src/index.ts
git commit -m "feat(insights): make refresh cadence env-configurable (INSIGHTS_INTERVAL_MS, default 6h)

Lets prod raise the insights cron frequency (e.g. to 2h) to shrink IG/FB per-link
metric refresh latency without a code change. Default unchanged. Bounded in practice
to stay under the shared ~200-call/hr Meta budget and keep the FB scraper polite.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Set the tuned env values on prod (post-merge, manual — .env is gitignored)**

After the deploy of Tasks 1-3 completes, SSH in and add the knobs. Keep it conservative first, then tighten after measuring.

```bash
ssh linode
cd /opt/dashmani-platform/apps/api
# Append the knobs (create if absent). 2h cadence + a 25-min polling budget per provider.
grep -q '^INSIGHTS_INTERVAL_MS=' .env || echo 'INSIGHTS_INTERVAL_MS=7200000' >> .env
grep -q '^INSIGHTS_METRIC_BUDGET_MS=' .env || echo 'INSIGHTS_METRIC_BUDGET_MS=1500000' >> .env
pm2 restart api && pm2 save
```

> **Do NOT** set `INSIGHTS_INTERVAL_MS` below `7200000` (2h) without re-running the live Meta-call-volume check in Task 4. The runtime-only knobs take effect on `pm2 restart` — no rebuild.

---

## Task 3: Show the real "last updated" time and drop the false "every 6h" promise

**Why:** The three Top Links panels hard-code `note: "… · updates every 6h"`, which is false for IG/FB. Each panel already receives `fetchedAt` on every row (`getTopLinksByPlatform` returns it), so the true freshness is `max(fetchedAt)` across the panel's own rows — no API change needed. Replace the fixed cadence claim with an honest "Updated Xh ago" and a truthful "refreshes periodically" note. Matches the codebase's "speak the truth" convention.

**Files:**
- Modify: `apps/internal/src/app/reports/page.tsx:544-582` (panel config `note`) and `:624` (note render).

- [ ] **Step 1: Add a relative-time helper near the top of the component file**

In `apps/internal/src/app/reports/page.tsx`, add a small pure helper (place it near the other local helpers in the file — search for an existing `fmtCompact`/`fmt` helper and colocate):

```typescript
// Human "updated N ago" from the newest fetchedAt across a panel's rows. Returns null
// when there are no rows (panel then shows only the cadence-agnostic note).
function relativeUpdated(rows: Array<{ fetchedAt?: string | Date | null }>): string | null {
  let newest = 0;
  for (const r of rows) {
    if (!r?.fetchedAt) continue;
    const t = new Date(r.fetchedAt).getTime();
    if (!Number.isNaN(t) && t > newest) newest = t;
  }
  if (!newest) return null;
  const mins = Math.max(0, Math.round((Date.now() - newest) / 60000));
  if (mins < 60) return `Updated ${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `Updated ${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `Updated ${days}d ago`;
}
```

- [ ] **Step 2: Change the three `note` strings to drop the cadence promise**

In the `PLATFORMS` array (lines 556, 568, 580), replace:

```typescript
            note: "YouTube · updates every 6h",
```
```typescript
            note: "Instagram · likes + comments · updates every 6h",
```
```typescript
            note: "Facebook · likes + comments · updates every 6h",
```

with (metric descriptor kept; cadence promise removed):

```typescript
            note: "YouTube · views",
```
```typescript
            note: "Instagram · likes + comments",
```
```typescript
            note: "Facebook · likes + comments",
```

- [ ] **Step 3: Render the real "Updated Xh ago" alongside the note**

At line 624, replace:

```tsx
                    <span className="ml-auto text-[10px] text-[#B0B0B0] shrink-0">{p.note}</span>
```

with a two-part label — the metric descriptor plus the honest freshness derived from the panel's own rows:

```tsx
                    <span className="ml-auto text-[10px] text-[#B0B0B0] shrink-0">
                      {p.note}
                      {(() => {
                        const rel = relativeUpdated(p.data);
                        return rel ? ` · ${rel}` : "";
                      })()}
                    </span>
```

- [ ] **Step 4: Update the links-analytics page label too (consistency)**

In `apps/internal/src/app/reports/links/page.tsx:434`, replace:

```tsx
                <span className="ml-auto text-[10px] text-[#B0B0B0] shrink-0">YouTube only · updates every 6h</span>
```

with:

```tsx
                <span className="ml-auto text-[10px] text-[#B0B0B0] shrink-0">YouTube only</span>
```

(YouTube *is* genuinely fresh every run, but dropping the specific "6h" number keeps every label consistent and avoids a promise the cadence knob can change.)

- [ ] **Step 5: Type-check and build the internal app**

Run: `npx tsc --noEmit -p apps/internal/tsconfig.json`
Expected: no errors.

Then the full build (auth/shared imports only surface in a full build — CLAUDE.md convention):

Run: `npm run build -w @dashmani/internal`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/internal/src/app/reports/page.tsx apps/internal/src/app/reports/links/page.tsx
git commit -m "fix(reports): show real 'Updated Xh ago' on Top Links panels, drop false 'every 6h'

The panels hard-coded 'updates every 6h', which is false for IG/FB (their per-link
refresh latency is days, cursor-based). Derive the true freshness from the newest
fetchedAt across each panel's own rows and show 'Updated Xh ago'; keep the metric
descriptor, remove the cadence promise. No API change — rows already carry fetchedAt.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Ship, then verify LIVE on prod (not just build/tests)

**Why:** CLAUDE.md is emphatic — cron/Graph fixes have repeatedly passed tests + build yet been broken on prod (the `limit=100`→500 IG discovery incident, the #64 projection-gate incident). Behavior must be confirmed against the live server.

**Files:** none (verification only).

- [ ] **Step 1: Open the PR, merge to `main`, let GitHub Actions auto-deploy (~3 min)**

```bash
git push origin <branch>
# open PR → review → merge to main
```

Confirm deploy: `curl -s https://api.digitalsukoon.com/v1/health` → `{"success":true,...}`.

- [ ] **Step 2: Apply the prod env knobs from Task 2 Step 4 and restart the API**

(2h cadence + 25-min metric budget, then `pm2 restart api && pm2 save`.)

- [ ] **Step 3: Watch the next few insights runs in the pm2 log and confirm IG now polls FAR more than ~350 links/run**

```bash
ssh linode "cd ~/.pm2/logs && grep -aE '\[social-insights/instagram\] [0-9]+ links' api-out.log | tail -6"
```
Expected: the `… → N polled` count is now in the **thousands**, not ~300-350. Also confirm `0 errors` (no new rate-limit) and that the harvest line still precedes the yield.

- [ ] **Step 4: Confirm Facebook is NOT starved and its scraper isn't getting blocked more**

```bash
ssh linode "cd ~/.pm2/logs && grep -aE '\[social-insights/facebook\] [0-9]+ links' api-out.log | tail -6; echo '--- FB scraper wall/block events (recent) ---'; grep -acE 'fbScraperBlocked|FB_SCRAPER_WALL|walled' api-out.log"
```
Expected: FB still runs every cycle with mostly `0 errors`; scraper-block events do NOT spike vs the pre-change baseline. **If FB block events rise materially, raise `INSIGHTS_INTERVAL_MS` back toward 6h** (constraint 6) — freshness is secondary to not getting the FB scraper IP-blocked.

- [ ] **Step 5: Re-run the DB freshness distribution after ~1-2 days and confirm the IG bulk moved into the <6h/6-24h buckets**

Use the same query as the investigation (latest-`ok`-per-link age buckets for IG/FB/YT). Expected after ~2 days at 2h cadence: the IG 7-30d bucket collapses toward near-zero; most IG links land in <6h/6-24h. Capture the before/after in the PR description.

- [ ] **Step 6: Confirm the UI**

Load `https://portal.digitalsukoon.com/reports` (hard refresh). The Top Instagram Links panel header should read `Instagram · likes + comments · Updated Xh ago` with a small X, and no "every 6h" text anywhere.

---

## Self-Review

**Spec coverage:** The issue asked to (a) confirm whether IG is rate-limited / token expired / cron reaching IG — **done in investigation: not rate-limited, token valid, cron reaches IG every run; refuted the audit's flag hypothesis with prod logs + DB distribution**; (b) fix root cause so IG refreshes within the promised window — **Task 1 (budget decoupling) + Task 2 (cadence) shrink the cycle from ~25 days to ~2 days**; (c) "consider splitting IG into its own run if throttled" — **not needed, because IG is not throttled; the cheaper budget-decoupling + cadence fix is preferred and preserves the FB-starvation guard** (this deviation from the audit's suggestion is deliberate and evidence-backed); (d) the misleading UI — **Task 3**. Facebook's identical latent bug is fixed by the same Task 1 change (not sabotaged).

**Placeholder scan:** No TBD/TODO/"handle edge cases". The one soft spot is Task 1 Step 1's test harness ("follow the existing mock pattern") — this is unavoidable without reading the repo's existing cron-test mocks, and the behavioral assertions (`batchCalls >= 5`, `harvestFlushedAtCall === 1`) are concrete. Flagged explicitly for the implementer.

**Type consistency:** `slugDeadline` changes from `const` to `let` and from a fixed value to `Number.MAX_SAFE_INTEGER` seed + rebased; `runStartedForSlug`, `METRIC_BUDGET_MS`, `INSIGHTS_INTERVAL_MS`, `INSIGHTS_METRIC_BUDGET_MS`, `relativeUpdated` are all introduced and consistently referenced. No schema/type changes to `TopLink`/`PlatformStat` (the panels already receive `fetchedAt`). Provider order and read-path names untouched.

**Constraints honored:** `igRateLimited`/`fbRateLimited` short-circuits, sequential loop, provider order, early-harvest gating, `status="ok"` read filter, no `db:push`, FB-scraper politeness — all preserved and called out.
