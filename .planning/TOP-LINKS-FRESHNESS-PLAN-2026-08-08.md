# Top Links freshness fix — IG/FB ranking lag

**Date:** 2026-08-08
**Problem:** Instagram Top Links median metric age ~502h (21 days); Facebook ~152h (6.3d).
High-performing IG links (millions of views) are missing from or mis-ranked in Top Links.
**Constraint:** must not increase Meta API call volume (shared ~200-call/hr budget), must not
change the read path / portal load characteristics.

---

## Measured baseline (prod, 2026-08-08)

Latest-snapshot age per ranked link:

| Platform | Ranked links | Median age | p95 age | Max |
|---|---|---|---|---|
| YouTube | 3,408 | 1.1 h | 343 h | 68 d |
| Facebook | 38,509 | 151.6 h | 720 h | 41.8 d |
| Snapchat | 91 | 150.5 h | 341.8 h | 14.2 d |
| Instagram | 20,759 | 501.8 h | 1,036.9 h | 44.3 d |

30-day coverage (submitted vs has an `ok` metric):

| Platform | Submitted 30d | With ok metric | Coverage |
|---|---|---|---|
| YouTube | 496 | 496 | 100% |
| Facebook | 17,918 | 12,028 | 67.1% |
| Instagram | 34,989 | 9,385 | 26.8% |

Latest-status mix (90d window):

| Platform | ok | not_found | rate_limited |
|---|---|---|---|
| facebook | 5,956 | 182 | 36,623 |
| instagram | 8,100 | 70,194 | — |
| youtube | 3,405 | 1 | — |

Sweep-queue composition (90d):

| Platform | ok fresh (<48h) | ok, post >30d old | not_found, post >30d old |
|---|---|---|---|
| facebook | 4,871 | 3,579 | 108 |
| instagram | 1,104 | 486 | **52,910** |
| youtube | 2,487 | 2,909 | 1 |

Submitted-link volume by recency:

| Platform | 7d | 30d | 90d |
|---|---|---|---|
| instagram | 6,837 | 34,989 | 90,457 |
| facebook | 3,617 | 17,918 | 44,868 |
| youtube | 66 | 496 | 3,202 |

---

## Root cause

`apps/api/src/cron/social-insights.cron.ts` selects the sweep queue with
`orderBy: { id: "asc" }` plus a resume cursor (`insights-cursor:<slug>`), bounded by a
25-min per-provider wall-clock budget (`INSIGHTS_METRIC_BUDGET_MS=1500000`), running every
2h (`INSIGHTS_INTERVAL_MS=7200000`).

`id ASC` is a **content-blind ordering**. Consequences:

1. A 90-day queue of ~90k IG links is walked in a fixed arbitrary order. With a 25-min
   budget, a full wrap takes many days — which *is* the observed ~21-day median age.
2. **52,910 IG links are old posts whose latest status is `not_found`** — the documented
   Meta feed-window ceiling (no fetch-by-id; only newest-first feed paging). They occupy
   ~90% of the queue and are polled ahead of fresh posts purely because their ids sort first.
3. FB links average 39–64 snapshots each; already-resolved, settled old posts are re-polled
   dozens of times while recent links wait.

So the lag is **not** an API-budget shortage. The same budget is being spent in the wrong order.

### Rejected approach (important)

"Permanently skip `not_found` links" — **rejected, would lose real data.** Measured recovery
of links that ever returned `not_found`:

| Platform | links ever not_found | later returned ok | recovery |
|---|---|---|---|
| facebook | 12,979 | 12,251 | **94.4%** |
| instagram | 70,724 | 12,891 | **18.2%** |

FB not_found is overwhelmingly transient (rate-limit/scraper wall). Even IG recovers 18%.
A blacklist would permanently delete ~12k FB + ~12k IG resolvable links from the rankings.
**Never exclude — only re-prioritise.**

---

## The fix: tiered priority sweep (zero extra API calls)

Replace the single `id ASC` queue with **three priority tiers**, each with its own cursor.
Budget, batch size (50), provider order, harvest logic, and total call volume are all unchanged.

- **Tier A — fresh (report_date within `INSIGHTS_FRESH_DAYS`, default 7).**
  Every run, from the start, no cursor. This is the tier that fixes the headline complaint:
  a link posted today gets a metric on the next 2h run instead of waiting for a full wrap.
  Volume is small and bounded (IG 6,837 / FB 3,617 over 7d).
- **Tier B — unresolved (older than fresh, latest status not `ok`).**
  Cursor-rotated. These are the coverage gap — the links that *could* still resolve (18% IG /
  94% FB recovery). They keep getting retries, just behind fresh links.
- **Tier C — settled (older, latest status `ok`).**
  Cursor-rotated, and only reached with leftover budget. Their numbers are already in the
  ranking; refreshing a 60-day-old post's view count is the least valuable work available.

Tiers are filled in order until the per-provider budget is spent. Every link remains reachable
— nothing is ever permanently dropped, so no coverage is sacrificed.

### Why this is the cheapest option

| Option | API cost | Freshness gain | Risk |
|---|---|---|---|
| **Tiered priority (chosen)** | **zero extra** | fresh links: ~21d → ≤2h | low — ordering only |
| Raise cadence / budget | +2-4× Meta calls | moderate | breaches ~200/hr budget; starves harvest (PR #110 regression) |
| Blacklist not_found | negative | high | **loses 12k FB + 12k IG real links** |
| Bigger server | £/mo | none | doesn't address ordering |

### Explicitly preserved (no portal/load regression)

- Read path (`social-insights.service.ts`) **untouched** — same SQL, same v2 covering index,
  same 60s `memoInsights` TTL cache. No change to `/reports` latency.
- `INSIGHTS_METRIC_BUDGET_MS`, soft/hard budget breaks, provider order, chunk size 50 unchanged.
- Early-harvest logic and `harvestedThisRun` semantics unchanged (Link Search unaffected).
- `harvestOnly` runs still never touch cursors.
- No schema change → **no `db:push`**.
- Fail-open: any tier-query error falls back to the current single-queue behaviour.

---

## Secondary fix: UI honesty

`TopLink.fetchedAt` is already returned by the API and simply not rendered. Add a relative
"as of" age to the Top Links panels so a stale row is legible as stale rather than implying a
live leaderboard. Frontend-only, no query change.

---

## Tasks

1. `social-insights.cron.ts` — tiered queue builder + per-tier cursors (fail-open).
2. Env knob `INSIGHTS_FRESH_DAYS` (default 7), documented.
3. Tests: tier ordering, fresh-first, cursor advance/wrap per tier, no-link-permanently-excluded.
4. Frontend: `fetchedAt` age label on Top Links panels (internal `/reports`).
5. Verify: build + apps/api suite green; deploy; confirm on prod that fresh-tier IG/FB links
   get metrics within one run and median age drops.
6. Update CLAUDE.md + memory.

## Verification criteria

- Fresh IG/FB links (posted <7d) have an `ok`/attempted metric within **one 2h run**.
- No increase in Meta calls per run (cost sheet / graphFetch counts flat).
- `/reports` load time unchanged.
- Total distinct links ever polled does not shrink (nothing blacklisted).
