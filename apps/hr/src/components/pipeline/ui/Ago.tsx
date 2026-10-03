"use client";
/**
 * useMinuteClock() and <Ago iso/> (H2): relative ages ("now", "5m", "2h", "3d") that stay
 * current while a tab is left open — WITHOUT re-rendering the memoised rows they sit in. Only
 * the subscribing span re-renders; MessageItem's memo stays intact.
 *
 * One module-level timer for the whole page, aligned to minute boundaries, PAUSED while the tab
 * is hidden (nothing to show) and caught up the moment it is visible again. The snapshot is the
 * start of the current minute — stable within the minute, so useSyncExternalStore sees a new
 * value at most once a minute. Ages are therefore at most a minute behind, never ahead.
 * Torn down with the last subscriber. The wording is the shared floor-based relativeShort, so
 * the thread agrees with both bells ("1h", never a rounded-up "2h").
 */
import { useSyncExternalStore } from "react";
import { msUntilNextMinute, relativeShort, startOfMinute } from "@dashmani/shared";

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function notify(): void {
  for (const l of [...listeners]) l();
}

function stop(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

function arm(): void {
  stop();
  // + 50 ms past the boundary, so the snapshot read in the callback is the NEW minute.
  timer = setTimeout(() => {
    timer = null;
    notify();
    if (listeners.size > 0 && document.visibilityState !== "hidden") arm();
  }, msUntilNextMinute(Date.now()) + 50);
}

function onVisibility(): void {
  if (document.visibilityState === "hidden") return stop();
  notify();
  arm();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (listeners.size === 1) {
    document.addEventListener("visibilitychange", onVisibility);
    if (document.visibilityState !== "hidden") arm();
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
}

const getMinute = () => startOfMinute(Date.now());

/** Epoch ms of the start of the current minute; re-renders the caller once a minute (visible tabs only). */
export function useMinuteClock(): number {
  return useSyncExternalStore(subscribe, getMinute, getMinute);
}

/** A live relative age for an ISO instant. Renders nothing for a missing or unreadable one. */
export function Ago({ iso }: { iso: string | null | undefined }) {
  const now = useMinuteClock();
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (!iso || !Number.isFinite(t)) return null;
  return <time dateTime={iso}>{relativeShort(now - t)}</time>;
}
