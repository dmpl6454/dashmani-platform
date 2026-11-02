"use client";
/**
 * useLocalDayKey() (H1): the browser-local `YYYY-MM-DD` — the repo's IST rule (browser local
 * time IS IST for users in India; never toISOString for "today").
 *
 * Pass it as a PROP into memoised rows (cards, messages): it changes exactly once a day, so a
 * row re-renders at local midnight and at no other time — "today shows 10:05 am" flips to a
 * dated label, "Due tomorrow" becomes "Due today", with no reload.
 *
 * One module-level timer for every caller: a setTimeout to the next local midnight + 1 s,
 * re-armed after each run, plus a refresh on visibilitychange (a background tab's timer can
 * be throttled or frozen past midnight). The snapshot is the key STRING itself, equal all day
 * (Object.is), so notifying more often than needed costs no render. Torn down with the last
 * subscriber.
 */
import { useSyncExternalStore } from "react";
import { localDayKey, msUntilNextLocalMidnight } from "@dashmani/shared";

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function notify(): void {
  for (const l of [...listeners]) l();
}

function arm(): void {
  if (timer !== null) clearTimeout(timer);
  // + 1 s: never land a hair before midnight and read the old day again.
  timer = setTimeout(() => {
    timer = null;
    notify();
    if (listeners.size > 0) arm();
  }, msUntilNextLocalMidnight(new Date()) + 1000);
}

function onVisibility(): void {
  if (document.visibilityState !== "visible") return;
  notify();
  arm();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (listeners.size === 1) {
    arm();
    document.addEventListener("visibilitychange", onVisibility);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
}

const getDayKey = () => localDayKey(new Date());

export function useLocalDayKey(): string {
  return useSyncExternalStore(subscribe, getDayKey, getDayKey);
}
