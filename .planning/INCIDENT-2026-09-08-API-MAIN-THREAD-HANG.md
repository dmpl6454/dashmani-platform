# Incident: API main-thread hang — 5h44m outage (2026-09-08)

**Impact:** 09:05 → 14:49:50 UTC (14:35 → 20:19 IST). Every portal appeared broken at once: HR login
intermittent/failing, channel dropdown empty, report submit failing, "data vanished", jobs portal
timing out. Root: the API process was alive, listening on :4000, at **99.9% CPU on its main thread**,
and answered nothing — nginx `upstream timed out` → 504 on every request. The database was intact
(109 users, 461 channels, 64 reports in the prior 3 days). The client-rendered portals returned
cached 200s (their shells load without the API), which is why it looked like a data problem.

Fix branch: `fix/insights-sweep-hardening`. No `db:push`.

## Timeline (UTC)

| Time | Event | Evidence |
|---|---|---|
| 04:27 | Sweep healthy: FB `3312 → 350 polled, 348 ok, 0 errors`, `done in 60 min` | api-out.log |
| 06:27 | FB `2962 → 750 polled, 248 ok, **500 errors**`; IG harvested 14,681 then **never logged a summary**; run never logged `done` | api-out.log |
| 08:27 | Second sweep **stacked** on the unfinished 06:27 run (no overlap guard) | api-out.log |
| 09:00:28 | Kernel OOM-killer takes the API (RSS 343MB). Box starved by unrelated tenants (see below), swap 1.2GB | dmesg |
| 09:01:48 | pm2 restarts API; sweep starts **immediately on boot**; YouTube ok; FB queue logged | api-out.log |
| ~09:03–09:05 | Freeze. FB discovery done but `published_posts` never called; follower-sync mid-run (6 accounts logged vs 99 in a healthy run, 2 Snapchat scrapes done) | api_usage, api-out.log |
| 09:05:34 | Last HTTP line (request never completed). `api_usage`: **zero rows from any provider 09:15 → 14:45** | api_usage |
| 11:01, 13:02 | Two bare `[social-insights] starting` lines, 9s/34s late — timers squeezed through; nothing else | api-out.log |
| 14:41 | Diagnosed: pid 984432 main thread R 99.9%, utime 17,835s vs stime 372s, no answer to localhost `/v1/health` in 150s | top -H, /proc |
| 14:49:50 | `pm2 restart api` → 200 in 4ms. Watchdog deployed. | — |
| 15:2x | Post-restart sweep: FB `350 polled, 348 ok, 0 errors` (vs 500 that morning) | api-out.log |

## Root causes (all latent; no application code had changed since Aug 31)

1. **No overlap guard on `runSocialInsightsRefresh()`.** A bare 2h `setInterval` fired regardless of
   whether the previous sweep had finished. Sweeps stacked; each held its own ~100–150MB of link
   queues + feed maps and competed for the one Meta call budget.
2. **Both Meta providers rebuilt their entire feed map on EVERY 50-link batch** (100–800 Graph calls
   and a fresh ~15k-entry Map per batch). The cron's comment claiming the map was "cached after the
   first batch" was false. This is why a Facebook phase spent its whole budget, why Meta throttled
   it (the "500 errors" = 10 batches × 50 links marked `rate_limited`, counted as errors), and why a
   sweep could outlive its 2h interval in the first place.
3. **The sweep ran immediately on boot.** After the OOM restart the identical queue (tier cursors only
   persist after a provider completes) hit the same path within minutes, so restarting could not fix
   the outage — until the process was restarted at a moment the poison input was absent.

### What actually burned the CPU — unproven, strongest suspect named

`api_usage` shows **zero outbound calls for 5.5h** and utime ≫ stime: one long synchronous JS
computation, not GC (V8 heap limit on the box is 1008MB; the process peaked at ~405MB RSS+swap),
not I/O, not swap thrash. Every regex and loop on the Facebook and Instagram insights paths was
timed against 3–5MB adversarial input and found linear (whole live FB reel parse: 0.9ms). The only
**proven O(n²)** code on a path active at the freeze is `snapchat-scraper.ts`:
`/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i` and the `[\s\S]*?<\/script>`
patterns — >10s at 3MB, unbounded beyond, triggered by e.g. a `<meta` literal inside a multi-MB
`__NEXT_DATA__` blob with few `>` characters. It runs inside follower-sync (boot + hourly), which
was mid-run when the loop froze. Not confirmed against the specific page served that morning; the
watchdog below captures a CPU profile if it ever recurs.

### Contributing: the production box is shared

Alongside the platform: `mysqld` + `php-fpm` (since ~Sep 2), and deployed 2026-09-08:
`ds-sales-agent` (Next 16 cluster ×2, 49/58 restarts in 3h), `ds-sales-worker`, RapidOCR Python
jobs spawning every few seconds at ~100MB. ~700MB of foreign RSS on a 2GB machine → the OOM kill
that started the cascade. Owner decision pending on moving them.

## Shipped in the fix branch

- `social-insights.cron.ts`: overlap guard — claimed synchronously before the first `await`, released
  in `finally`, concurrent tick **logs and SKIPS** (never takes over: that cannot stop the old JS),
  `STALE` warning when the in-flight run is >4h. `resetSocialInsightsRunStateForTests()`.
- `index.ts`: `INSIGHTS_BOOT_DELAY_MS` (default 10 min), `INSIGHTS_ENABLED=0` kill switch (previously
  the only way to stop the sweep was unsetting shared tokens, which also kills follower-sync and the
  IG caption backfill), and a clamp at Node's setInterval ceiling (above 2^31−1 ms Node coerces to
  **1 ms** — a well-meant "lengthen the interval" would have become a sweep storm).
- `facebook.provider.ts` / `instagram.provider.ts`: feed map reused for `FEED_MAP_TTL_MS` (20 min)
  within a sweep. A rate-limited (possibly partial) build is harvested but **never** reused.
- `snapchat-scraper.ts`: all four `<script>`/`<meta>` regexes replaced by indexOf-based linear
  extraction (+ 4MB parse cap). `follower-sync.service.ts`: the YouTube `accessibilityLabel` regex
  (same O(n²) class) replaced likewise.
- `facebook-scraper.ts`: captions `flatCopy()`'d — a regex capture is a V8 SlicedString that pins the
  whole 1.6MB page; measured 200 captions = 320MB retained, 3MB flattened.
- Tests: 4 overlap-guard, 6 hostile-input parsing (timed), 4 feed-map reuse. Full suite green.

## Ops actions taken on the server (not in repo)

- API restarted 14:49:50Z (service restored).
- `api-watchdog` — a pm2-managed service (`/root/api-hotloop-watchdog.sh` + `api-hotloop-profile.mjs`,
  no expiry, in `dump.pm2`): every 10s, if API CPU >85% **and** `/v1/health` ≠ 200 for 60s → attach
  inspector, 5s CPU profile to `/root/api-hotloop-*.cpuprofile` (names the spinning function), then
  `pm2 restart api`. Finds the API via `pm2 pid api` (pm2 sets `process.title`, so `pgrep -f tsx`
  no longer matches).
- `api` redefined as a DIRECT node process: `pm2 start apps/api/src/index.ts --name api
  --cwd /opt/dashmani-platform --interpreter /usr/bin/node --node-args="--require …/tsx/dist/preflight.cjs
  --import file://…/tsx/dist/loader.mjs" --max-memory-restart 800M --time`. pm2 now monitors the real
  process (mem column 203MB, not 3.5MB), the cap is effective, logs are timestamped. Before the switch,
  `JWT_SECRET` / `NODE_ENV` / app URLs were verified byte-equal between the old pm2-level env and
  `apps/api/.env` — a differing `JWT_SECRET` would have invalidated every session.
- `ds-sales-agent` ×2 and `ds-sales-worker` `pm2 stop`ped (owner-authorized): free memory 142 → 296MB,
  swap 1.2GB → 0.83GB. Reversible with `pm2 start ds-sales-agent ds-sales-worker`. `scripts/deploy.sh`
  changed from `pm2 restart all` to naming the platform's five processes, because `restart all` revives
  stopped apps and would have undone this on the very next deploy. ⚠️ The first version used ONE multi-name
  call and pm2 cycled EVERY process in id order (stopped ds-sales included — they came back online during
  the PR #140 deploy); it now loops one `pm2 restart <name>` per app, which is verified to touch only
  that process.

## Still open

- An `ecosystem.config.js` in git so the pm2 process definition is not only in the server's `dump.pm2`
  (a `pm2 delete` + `start` by hand silently dropped the July memory cap once already).
- Foreign tenants (ds-sales-agent/worker, OCR jobs, mysqld/php-fpm) off the 2GB production box.
- Persist tier cursors per batch so a mid-sweep hang cannot replay the identical queue.
- `statement_timeout` on the Prisma URL; bound `recordApiUsage` (one un-awaited insert per Graph call).

## Diagnostic lessons

- **Timers firing late-but-firing does not mean the event loop is healthy.** Two `starting` lines in
  5.5h coexisted with zero I/O completions.
- **`api_usage` is a liveness oracle** for this API: every provider call inserts a row; zero rows in a
  window = zero async progress.
- **pm2 `online` + tiny memory = you are looking at the wrapper.** `pm2 pid api` → bash; the worker is
  its child. `top -H -p <child>` + `/proc/<child>/stat` utime/stime split separates GC/regex burn
  (user) from page-fault thrash (kernel).
- `pgrep -f <script-name>` matches your own SSH command line → false "already running". Anchor it.
- `psql -c "…"` inside `ssh '…'` turns `"` into SQL identifiers; pipe SQL through `bash -s` + heredoc.
- The inspector's `Debugger.pause` works on a pegged thread, but issue `Debugger.enable` and wait
  before pausing or `url` comes back empty; a CPU profile (`Profiler.start/stop`) is more diagnostic.

## 2026-09-09 follow-up — sales-agent moved to its own box; residues removed from prod

The owner moved `ds-sales-agent` to a separate Linode (173.230.131.144, 1 vCPU / 961MB) and repointed the
local `ssh linode` alias at it. **Production is still 172.105.53.101**; a `dashmani-prod` alias was added and
every `ssh linode` in CLAUDE.md now reads `ssh dashmani-prod`. ⚠️ The first cleanup attempt ran its read-only
inventory against the NEW box because of the alias change and was aborted before any mutation — always confirm
`ls /opt/dashmani-platform` succeeds before touching a server.

Removed from prod, all with zero portal impact (verified before/after: API 200 in ~3ms, portals 200, 0 API 5xx):
- pm2 entries ids 6/7/8 (`ds-sales-worker`, `ds-sales-agent` ×2) — `pm2 delete <id>` one per call, name-checked
  (a multi-target pm2 command is how yesterday's deploy revived them); `pm2 save` → resurrect set is platform-only.
- nginx site `ds-sales-agent` (`e035e4d46c.digitalsukoon.com` → :3100) — unlinked, `nginx -t`, graceful reload.
- `/opt/ds-sales-agent` (1.1G), `/opt/ds-ocr-venv` (387M), `/root/.ds-sales-agent-data` (682M) — renamed into
  `/root/quarantine-ds-sales-2026-09-09` (instant), then purged by `ionice -c3 nice -n19 rm -rf` in the background.
  `/opt/ds-ocr-bakeoff` (18M) does not exist on the new box and is kept in the quarantine dir.
- 91 rotated pm2 log files, `/var/log/ds-accuracy.log`.
- Left in place on purpose: `/root/.local/share/pnpm` (963M) — `posting-automation` also uses pnpm.

Nothing else referenced the project on prod: no crontab lines, no systemd units, no certbot certificate.
