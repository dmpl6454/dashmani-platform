"use client";
/**
 * Connection state in words (spec §5.5, §9.8). Data is never cleared while any of these
 * show. Renders nothing while live.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { WifiOff, RotateCw } from "lucide-react";
import type { SyncEngine } from "../sync-engine";

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

function clock(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function StatusPill({ engine }: { engine: SyncEngine }) {
  const st = useSyncExternalStore(engine.subscribeStatus, engine.getStatus, engine.getStatus);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  let text: string | null = null;
  let icon: React.ReactNode = null;
  if (!st.online) {
    text = st.lastOkAt ? `Offline — updated ${clock(st.lastOkAt)}` : "Offline";
    icon = <WifiOff size={12} />;
  } else if (st.indicator === "reconnecting") {
    text = st.lastOkAt ? `Reconnecting… · updated ${ago(now - st.lastOkAt)}` : "Reconnecting…";
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
