/**
 * Posting watch scheduler — one tick a minute, all day; outside 07:00–23:00 IST a tick
 * returns before touching the database or Meta. The tick itself is bounded and guarded
 * (services/meta-oauth/posting-watch.service.ts runPostingWatchTick).
 *
 * Kill switches:
 *  - POSTING_WATCH_ENABLED=0 in apps/api/.env — nothing is scheduled (restart needed);
 *  - system_settings `postingWatch.mode` = "off" — ticks skip within a minute, no restart.
 */
import { postingWatchConfig, runPostingWatchTick } from "../services/meta-oauth/posting-watch.service";
import { scrubSecrets } from "../utils/token-crypto";

export function startPostingWatchCron(): { stop(): void } {
  const cfg = postingWatchConfig();
  if (!cfg.enabled) {
    console.warn("[posting-watch] DISABLED via POSTING_WATCH_ENABLED=0 — channels will not be checked in this process");
    return { stop() {} };
  }
  const tick = () => {
    runPostingWatchTick().catch((err) => console.error("[posting-watch] tick failed:", scrubSecrets(String(err))));
  };
  let interval: ReturnType<typeof setInterval> | null = null;
  console.log(
    `[posting-watch] first tick in ${Math.round(cfg.bootDelayMs / 60_000)} min, then every ${Math.round(cfg.tickMs / 1000)}s ` +
      "(checks run only inside the IST monitoring window)",
  );
  const first = setTimeout(() => {
    tick();
    interval = setInterval(tick, cfg.tickMs);
    interval.unref?.();
  }, cfg.bootDelayMs);
  first.unref?.();
  return {
    stop() {
      clearTimeout(first);
      if (interval) clearInterval(interval);
    },
  };
}
