"use client";
/**
 * Connection state in words (spec §5.5, §9.8). Data is never cleared while any of these
 * show. Renders nothing while live.
 *
 * Times use the shared helpers (2026-10-01): "updated 5m ago" floors like both bells, and an
 * offline label from another day carries its date ("updated Wed, 30 Sep, 11:50 pm") — after an
 * overnight offline stretch a bare "14:05" read as today's. It re-renders on the page's one
 * minute clock (paused while the tab is hidden), not on a timer of its own.
 */
import { useSyncExternalStore } from "react";
import { WifiOff, RotateCw } from "lucide-react";
import { localDayKey, relativeAgo, timeLabel } from "@dashmani/shared";
import type { SyncEngine } from "../sync-engine";
import { useMinuteClock } from "./Ago";

export function StatusPill({ engine }: { engine: SyncEngine }) {
  const st = useSyncExternalStore(engine.subscribeStatus, engine.getStatus, engine.getStatus);
  const now = useMinuteClock();

  let text: string | null = null;
  let icon: React.ReactNode = null;
  if (!st.online) {
    text = st.lastOkAt ? `Offline — updated ${timeLabel(st.lastOkAt, localDayKey(new Date(now)))}` : "Offline";
    icon = <WifiOff size={12} />;
  } else if (st.indicator === "reconnecting") {
    text = st.lastOkAt ? `Reconnecting… · updated ${relativeAgo(now - st.lastOkAt)}` : "Reconnecting…";
    icon = <RotateCw size={12} className="animate-spin pl-anim" />;
  } else if (st.indicator === "rate_limited") {
    text = "Live updates paused for a moment";
  } else if (st.waking && st.lastOkAt) {
    text = "Updating…";
  }
  if (!text) return null;
  return (
    <span
      role="status"
      className="inline-flex min-w-0 max-w-full items-center gap-1.5 h-7 px-2.5 rounded-full bg-muted text-ink-3 text-[11.5px] font-semibold"
    >
      {icon}
      <span className="truncate">{text}</span>
    </span>
  );
}
