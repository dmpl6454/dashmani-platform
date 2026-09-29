# Pipeline load and concurrency report (PR 12, M5)

Date: 2026-09-29. Branch `test/pipeline-proof` (from `feat/pipeline-notifications`). Nothing was deployed and no prod system was touched.

**Verdict: not a clean pass.** 10 of the 13 load criteria passed in both run pairs. Two more (sync p95, login p95) passed in one pair and failed in the other. One failed in both runs: the heavy user's R1 hold. The concurrency suite found two real bugs, and both are fixed. The heavy-user hold needs an owner decision (see "Open item").

## What was built

| Piece | Where |
|---|---|
| Concurrency suite (own config, own DB, pipeline pool at 3) | `apps/api/vitest.concurrency.config.ts`, `apps/api/tests-concurrency/pipeline/` |
| Load harness: compose file with every service on `cpuset "0"` and 2 GB in total (Postgres 640m, API 1216m, nginx+TLS 64m, co-tenant 128m) | `scripts/load/docker-compose.load.yml`, `api.Dockerfile`, `nginx.conf`, `cotenant.js` |
| API entry for the load run: prod tsx loader, `monitorEventLoopDelay`, synthetic cron workload. It lives in `scripts/load`, so no load-test code ships in `apps/api/src` | `scripts/load/api-entry.ts`, `api-supervisor.sh` |
| Seed and traffic driver. It refuses anything except `localhost:55432/dashmani_load` | `scripts/load/pipeline-load.ts`, `run-load.sh` |
| M6 flag script and the hourly `[pipeline] stats` line | `scripts/pipeline-flag.ts`, `apps/api/src/services/pipeline/stats.ts` |

### Harness setup

**Data:**
- 115 users and 120 HR tokens;
- 300 live projects and 60,000 messages;
- the heavy user (id `…beef`) takes part in all 300 live projects plus 2,000 archived ones, which is 2,300 lifetime participations;
- 230 social accounts.

**Traffic mix (10 minutes per run, as instructed):**
- 120 tabs, 60% board and 40% project, at the default cadence (15 s and 10 s). All tabs are visible the whole run, which is about 2× the spec's "60 visible tabs" peak.
- A bell poll every 30 s per tab.
- About 1 message/s, plus reactions (about 0.3/s) and moves (about 0.1/s).
- Evening-rush HR submits: every user submits once, about 30% update later, and 20% of submits carry 450 links.
- A login every 4–6 s and Link History every 3–5 s.
- One `next build` of apps/hr with `--max-old-space-size=900` at 2:00, inside the API cgroup.
- `kill -INT` of the API at 5:00, then a 30-client herd.
- A triage burst at 7:00: 30 messages plus 40 project opens in one minute for one user.
- A co-tenant using about 25% CPU plus fsync IO.
- In-process synthetic crons: a batch upsert every 20 s, a 1.7 MB JSON parse every 30 s and a sequential write loop every 60 s.

**Prod settings:**
- `connection_limit=10`;
- `DB_STATEMENT_TIMEOUT_MS=60000`;
- `NODE_ENV=production`;
- `PIPELINE_DB_CONNECTIONS=3`.

**Baseline** means `pipeline.mode` is absent. Clients call bootstrap once and then stop, as the real HR client does.

## Bugs found and fixed (test-first, red before green)

1. **The board never loaded.** `sync.service.ts` has a `setBoardSnapshotProvider` seam, and no production code ever registered it. Every board-mounted sync answered `board: null` with the client's own `v`, so the HR board stayed empty forever.
   - Found by: the concurrency suite's board-bump heal test.
   - Fix: register the provider in `services/pipeline/index.ts`.
   - Locked by: `tests/pipeline/board-sync-wiring.test.ts` (red, then green). Commit `f8d8890`.
2. **Concurrent rebalancing moves deadlocked.** A move locked its own card first, and the rebalance then locked the whole phase in id order. So the spec §6 claim "consistent lock order, no deadlock" did not hold.
   - Measured: 5 concurrent rebalancing moves returned 5 × 503 (55P03).
   - Fix: a move that needs a rebalance aborts while holding nothing. It then re-runs with the card and the target phase's live rows locked in one id-ordered statement.
   - After the fix: 5 × 200, and every placement is honoured. Commit `6e271e4`.

## Concurrency suite: 10 tests, run 20 times

`DATABASE_URL=…/dashmani_pipeline_cc?connection_limit=10 PIPELINE_DB_CONNECTIONS=3 npx vitest run -c vitest.concurrency.config.ts`

What each run covers:
- 30 parallel posts;
- skip-freedom, 20 rounds per run, with odd rounds paging the delta 3 rows at a time;
- 8 parallel moves;
- 12 cards dropped into one gap;
- a forced rebalance under 5 moves;
- 10 parallel adds;
- 10 identical reaction PUTs;
- 8 duplicate-clientId posts;
- fan-out vs. ack vs. mark-all-read, 500 interleavings;
- an injected board-bump failure that the next request heals.

**First 20 runs: 18 of 20 green.**
- Each skip-freedom run did 2,808–3,109 syncs and checked 1,506–1,621 messages, with 0 skips and 0 duplicate (id, rev) pairs.
- Runs 18 and 19 each had one or two `503 PIPELINE_BUSY` responses: a 55P03 lock_timeout, plus one bulkhead wait. They came during an `npm ci` Docker image build that saturated the same Docker VM, from 12:38 to 12:40.
- There was never a 500, a skip or a wrong invariant.

**Quiet rerun, 20 runs: 20 of 20 green, 0 × 503.** Each skip-freedom run did 2,821–2,915 syncs and checked 1,523–1,621 messages, with 0 skips and 0 duplicates.

## Load runs (10 minutes each, two pairs)

Latency is client-side, through nginx and TLS, with the ~3 s restart window excluded. p50 / p95 in ms, with the sample count first.

| Class | baseline 1 | enabled 1 | baseline 2 | enabled 2 |
|---|---|---|---|---|
| pipeline sync | — | 5710: 7.1 / **31.8** | — | 5744: 6.5 / **19.2** |
| pipeline post | — | 620: 9.6 / 44.0 | — | 630: 8.5 / 24.0 |
| HR login | 118: 90.4 / 167.7 | 117: 87.3 / **243.0** | 117: 84.4 / 227.8 | 116: 86.0 / 154.2 |
| HR submit (≤ 450 links) | 139: 38.6 / 112.8 | 146: 38.8 / 118.7 | 149: 36.9 / 125.8 | 149: 29.5 / 86.5 |
| /hr/reports/today | 139: 6.0 / 20.0 | 146: 5.3 / 24.4 | 149: 7.5 / 27.6 | 149: 5.5 / 22.4 |
| Link History | 151: 9.6 / 39.5 | 149: 9.0 / 41.1 | 148: 9.8 / 47.9 | 149: 8.2 / 29.8 |
| bell count | 2388: 5.3 / 16.3 | 2377: 4.2 / 17.9 | 2381: 4.7 / 14.8 | 2385: 3.7 / 11.9 |
| post-restart herd | 60: 70.5 / 127.9 | 90: 43.8 / 317.5 | 60: 64.7 / 130.5 | 90: 27.5 / 239.7 |

**Pair 2, excluding the `next build` window** (26–39 s):
- login 83.2 / 119.4 in the baseline and 85.7 / 124.8 enabled, which is **+4.5%**;
- submit 35.5 / 115.0 in the baseline and 29.0 / 80.1 enabled;
- sync 6.5 / 18.0 and post 8.4 / 21.6.

**CPU**, from docker stats, as a percentage of the one pinned core:
- baseline 2: median 29.5 (22 of that is the co-tenant);
- enabled 2: median 31.6, p95 63.8;
- the API itself: 3.0 → 4.7;
- Postgres: 1.3 → 2.2.

### Criteria

| Criterion | Run 1 | Run 2 | Result |
|---|---|---|---|
| 0 × 429 and 0 × 5xx on non-pipeline routes, outside the ~3 s kill/restart window | 0 / 0 of 2,935 | 0 / 0 of 2,948 | PASS |
| (inside the restart window: nginx 502 while the process is down) | 13 of 22 | 10 of 21 | expected |
| Triage burst: 0 user-visible 429s | 0 of 110 | 0 of 110 | PASS |
| 0 P2024 / P2028 / pool timeouts (API log grep) | 0 | 0 | PASS |
| Pipeline connections ≤ 3, sampled every 1 s via `application_name`, 598 samples per run | max 3 (baseline 1) | max 3 (baseline 2) | PASS |
| Sync p95 < 30 ms | **31.8** | 19.2 | FAIL in run 1, PASS in run 2 |
| Post p95 < 100 ms | 44.0 | 24.0 | PASS |
| Heavy user R1 hold p95 ≤ 3 ms (server-side, about one sample per 10 s window) | **p50 7.8, p95 22.0**, 59 samples | **p50 11.5, p95 29.6**, 40 samples | **FAIL** |
| Login p95 within 10% of baseline | **+45%** (243.0 vs 167.7) | −32% (154.2 vs 227.8); +4.5% excluding the build | FAIL in run 1, PASS in run 2 |
| HR-submit p95 within 10% | +5.2% | −31% | PASS |
| HR first-submit error rate within 10% | 0 of 115 vs 0 of 114 | 0 of 115 vs 0 of 115 | PASS |
| Event-loop delay p99 < 50 ms (cumulative histogram, before the kill / after the restart) | 8.79 / 5.96 | 7.30 / 6.62 | PASS |
| (worst 10 s window p99, during `next build`) | 65.7 | 18.8 | — |
| API RSS delta ≤ 100 MB (median, enabled − baseline) | +17 MB (218 vs 201) | +2 MB (205 vs 203) | PASS |
| Zero duplicate messages or notifications after the restart | 621 stored for 621 acked, 1 retried; 0 duplicate clientIds; 0 duplicate unread grouped rows | 632 for 632, 1 retried; 0 / 0 | PASS |
| Pipeline 503 / 409 / 429 counts (server stats) | 0 / 0 / 0 | 0 / 0 / 0 | — |

Notes:
- The login and sync p95 swing more between the two identical runs than the ±10% the criterion allows, in both directions. Login p95 is the 6th-slowest of about 117 samples, and it lands where the `next build` lands. The build-excluded comparison (+4.5%) is the stable number.
- The RSS baseline already holds an idle `pipelineDb`: its self-check connects even with the mode off. So the delta measures the feature running under load, not whether the second engine exists at all.

## Open item: the heavy user's R1 hold (FAILED, needs a decision)

**Measured.** Every figure below is from the load DB in the pinned cgroup unless it says "host".

| Condition | Heavy user (300 live, 2,300 lifetime) | Normal user (~16 live) |
|---|---|---|
| Idle, co-tenant on: server hold p95 | 15.0–17.1 ms | 5.0–5.9 ms |
| Idle, co-tenant off: server hold p95 | 13.6–16.0 ms | 4.7–7.3 ms |
| psql EXPLAIN ANALYZE, execution time | 2.2 ms | — |
| psql prepared statement, 12 runs | median ≈ 2.7 ms, later runs 1.3 ms | 0.3 ms |
| host → Prisma, current SQL: p50 / p95 | 3.96 / 7.61 ms | 0.51 / 3.31 ms |
| host → Prisma, §2 "one PK lookup per participant" (LATERAL): p50 / p95 | 3.93 / 8.00 ms (no gain) | 0.49 / 0.93 ms |
| host → Prisma, overlay hash in SQL (mine omitted when unchanged): p50 / p95 | 3.40 / 7.86 ms | 0.53 / 0.60 ms |

**Conclusion.** The cost follows the size of the **live** overlay: 300 JSON entries are built on every sync. It does not follow the lifetime scan that the spec's §2 fix targets. That fix was measured and does not help, so it was **not applied**, and nothing was changed on speculation.

**Options** (a design choice):
1. Accept a per-user bound on *live* participations. For example, ≤ 3 ms holds up to roughly 50–100 live projects on this CPU.
2. Send the overlay incrementally, only the changed rows since `mineH`.
3. Accept a higher hold target for such users.

Across all users under load, the median of each window's hold p95 was also 8.8–8.9 ms (the §8.3 target is ≤ 3 ms). On this pinned Docker CPU, even an idle normal user's hold is 5–7 ms. So the §8.3 hold budgets look optimistic for the 1-vCPU box in general. They should be re-checked on the real box during the pilot through the new `hold_p95` stats field.

## Main suite

`cd apps/api && DATABASE_URL=…/dashmani_t_api7?connection_limit=1 npx vitest run`: **87 files, 1,147 of 1,147 tests passed** (431 s). The main config now excludes `tests-concurrency/**`. The first full run picked the suite up under pool 1 and prod rate limits, and failed on 429s. CI would have done the same.

## Plan and spec deviations

- **Run length:** 2 × 10 minutes, as instructed for this task, not the plan's 20.
- **Report path:** this file, as instructed, not `.planning/PIPELINE-LOAD-REPORT.md`.
- **`application_name=dashmani-pipeline` on the pipeline pool.** It is inside `options`, hand-encoded. Without it `pg_stat_activity` cannot count the pipeline pool, so the "≤ 3 connections" criterion and pilot monitoring could not be measured.
- **Keys at 64 characters, not 63.** The rebalance test seeds 64-character keys, because a 63-character seed does not force a rebalance on the first move.
- **Harness setup:** the co-tenant is a Node duty-cycle loop. The HR submit URLs are unique Instagram and YouTube links (no Facebook `/share/`, so there is no network). Social insights are disabled (`INSIGHTS_ENABLED=0`).

## Concurrency rerun (quiet window)

After the load stack was torn down, the suite was rerun 20 times: **20 of 20 passed (10 of 10 tests each), with 0 × 503 and 0 × 500.** Across the 20 runs, skip-freedom did 57,202 syncs and checked 31,364 final message states, with 0 skips and 0 duplicate deliveries.

The two first-batch failures therefore track host saturation, and the pipeline's answer to that saturation was the designed 503 PIPELINE_BUSY, never a 500. They are not a code defect.
