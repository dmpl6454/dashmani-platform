/**
 * `console.warn` at most once per key per 10 s, carrying a count of the lines it held back.
 *
 * For signals that are EXPECTED under load but must stay visible in the pm2 log — pipeline
 * 429s, 413 / malformed-JSON bodies, 503 PIPELINE_BUSY — without flooding it. The
 * 2026-09-18 "Too many requests" storm left no trace because 429s were never logged; one
 * line per bucket per 10 s is enough to see a storm and its size.
 *
 * In-process and bounded: at most MAX_KEYS keys (the map is cleared beyond that), no timers.
 */
const WINDOW_MS = 10_000;
const MAX_KEYS = 100;

const state = new Map<string, { at: number; suppressed: number }>();

/** @returns true when the line was written, false when it was held back. */
export function warnThrottled(key: string, line: string, now: number = Date.now()): boolean {
  const s = state.get(key);
  if (s && now - s.at < WINDOW_MS) {
    s.suppressed++;
    return false;
  }
  const held = s && s.suppressed > 0 ? ` (+${s.suppressed} held back since the line ${Math.round((now - s.at) / 1000)}s ago)` : "";
  if (!s && state.size >= MAX_KEYS) state.clear();
  state.set(key, { at: now, suppressed: 0 });
  console.warn(`${line}${held}`);
  return true;
}

/** Tests only. */
export function resetThrottledWarnForTests(): void {
  state.clear();
}
