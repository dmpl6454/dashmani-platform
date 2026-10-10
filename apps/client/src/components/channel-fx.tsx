"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { NAV_CHANNELS, channelIndex, pad2 } from "@/lib/nav";
import { finePointer, reducedMotion, tilt, untilt } from "@/lib/motion";

/* The website's "channel surf" feel, inside the portal:
   - a scanline film over the screen and a burst of static when the channel changes;
   - ↑/↓ (or ←/→) step through the channels, 1–7 jump, like the site's rail;
   - cards with .v3-card-lift tilt toward the cursor;
   - an edge hint naming the keys, desktop only.
   Everything is skipped under prefers-reduced-motion. Keys are ignored while typing. */
export function ChannelFx() {
  const pathname = usePathname();
  const router = useRouter();
  const [noise, setNoise] = useState(false);
  const last = useRef<string | null>(null);
  const timers = useRef<number[]>([]);

  // Static burst on every channel change (not on the first paint).
  useEffect(() => {
    const ch = channelIndex(pathname);
    const key = ch >= 0 ? NAV_CHANNELS[ch].id : pathname;
    if (last.current !== null && last.current !== key && !reducedMotion()) {
      setNoise(true);
      timers.current.forEach(clearTimeout);
      timers.current = [window.setTimeout(() => setNoise(false), 220)];
    }
    last.current = key ?? null;
    return () => timers.current.forEach(clearTimeout);
  }, [pathname]);

  // Keyboard: ↓/→ next, ↑/← previous, 1–7 jump.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input,select,textarea,[contenteditable=true],[role=dialog]")) return;
      if (document.querySelector("[role=dialog], .palette-shell")) return;
      const cur = channelIndex(pathname);
      const n = NAV_CHANNELS.length;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        if (cur < 0) return;
        e.preventDefault();
        router.push(NAV_CHANNELS[(cur + 1) % n].href);
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        if (cur < 0) return;
        e.preventDefault();
        router.push(NAV_CHANNELS[(cur - 1 + n) % n].href);
      } else if (/^[1-7]$/.test(e.key)) {
        const i = Number(e.key) - 1;
        if (i !== cur) router.push(NAV_CHANNELS[i].href);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pathname, router]);

  // Card tilt, delegated so every page gets it for free.
  useEffect(() => {
    if (!finePointer() || reducedMotion()) return;
    let active: HTMLElement | null = null;
    const onMove = (e: MouseEvent) => {
      const card = (e.target as HTMLElement | null)?.closest?.(".v3-card-lift") as HTMLElement | null;
      if (active && active !== card) { untilt(active); active = null; }
      if (card) { active = card; tilt(card, e.clientX, e.clientY); }
    };
    const onLeave = () => { if (active) { untilt(active); active = null; } };
    document.addEventListener("mousemove", onMove, { passive: true });
    document.addEventListener("mouseleave", onLeave);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseleave", onLeave); onLeave(); };
  }, []);

  const ch = channelIndex(pathname);
  return (
    <>
      <div className="scanlines" aria-hidden />
      <div className={`static${noise ? " on" : ""}`} aria-hidden />
      <div className="edge-hint" aria-hidden>
        {ch >= 0 && <span className="edge-ch">CH {pad2(ch + 1)} / {pad2(NAV_CHANNELS.length)}</span>}
        <span>↑ ↓ change channel · 1–7 jump · Ctrl K search</span>
      </div>
    </>
  );
}
