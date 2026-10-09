"use client";

/**
 * Account Growth, opened IN PLACE over the overview — the owner asked that clicking a KPI
 * card's "Open Account Growth" (and the cards' "View All") must not navigate away from
 * the overview. It renders the very same boards as /accounts/growth (`GrowthView`), so the
 * two can never disagree; only the tab lives in local state here instead of the URL.
 *
 * ⚠️ PORTALLED TO <body> AND WRAPPED IN `.ds-root`. The boards are styled for the portal's
 * dark shell (`.ds-root` supplies the base font, colour-scheme for native pickers, focus
 * rings), and inside `.ov-root` they would inherit the overview's own resets instead.
 * ⚠️ data-theme="dark": the overview plane is always dark, so this panel pins the dark
 * palette even when the portal is in light theme.
 * ⚠️ z-index 45/46: above every overview layer (drawer tops out at 43) — the callers close
 * those layers before opening this anyway.
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ModalPortal } from "@/components/modal-portal";
import { GrowthView, type GrowthTab } from "../accounts/growth/_growth-view";

/**
 * A brighter dark palette scoped to THIS panel only. Inside the panel the boards' cards
 * (ds-card) sat on a background (ds-bg) a hair apart, with muted secondary text, so the
 * whole panel read as dim over the already-dark overview. Re-pointing the theme variables
 * on the dialog lifts the surfaces, borders and secondary text for everything inside it —
 * the standalone /accounts/growth page and the rest of the portal are untouched.
 */
const PANEL_PALETTE = {
  // Surfaces stay deep navy (dark theme, close to the portal's own) …
  "--ds-bg": "7 15 23", "--ds-card": "11 23 34", "--ds-inset": "14 28 41", "--ds-hover": "18 34 48",
  "--ds-chip": "20 37 52", "--ds-grid": "22 40 56",
  // … while borders and secondary text are lifted so every card and divider stays visible.
  "--ds-line": "40 66 88", "--ds-line2": "52 84 108", "--ds-line3": "66 102 130", "--ds-line4": "86 124 154",
  "--ds-t2": "196 207 219", "--ds-t3": "152 167 184", "--ds-t4": "116 132 150", "--ds-t5": "226 232 238",
  "--hx-2A4658": "#3E6580", "--hx-132430": "#1C3244", "--hx-0A1620": "#0E1C29", "--hx-1A2C38": "#30506A",
  "--hx-101E29": "#243C50", "--hx-182C39": "#2C4A62", "--hx-1D3444": "#33536C", "--hx-1F3442": "#33536C",
  "--hx-0B1824": "#0F1D2A", "--hx-08131C": "#0B1722", "--hx-0B1720": "#0E1C29", "--hx-0F1F2B": "#13283A",
  "--hx-10222E": "#13283A", "--hx-14273A": "#22394E", "--hx-223543": "#36566F",
  "--hx-738395": "#98A7B8", "--hx-A7B3C2": "#C4CFDB", "--hx-4A6275": "#7A90A6", "--hx-33506A": "#5F7A92",
} as CSSProperties;

export function GrowthOverlay({ onClose, initialTab = "meta" }: { onClose: () => void; initialTab?: GrowthTab }) {
  const [tab, setTab] = useState<GrowthTab>(initialTab);
  // The close button lives inside a portal that mounts one render later, so it is
  // focused from its ref callback rather than from the mount effect (where it is null).
  const focused = useRef(false);
  const focusClose = (el: HTMLButtonElement | null) => {
    if (el && !focused.current) { focused.current = true; el.focus(); }
  };
  // Held in a ref so a parent passing an inline arrow can't re-run the mount effect
  // (which would re-steal focus and toggle the scroll lock on every parent render).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // The overview scrolls the document; keep it still behind the panel.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCloseRef.current(); };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      opener?.focus?.();
    };
  }, []);

  return (
    <ModalPortal>
      <div className="ds-root contents" data-theme="dark">
        <div className="fixed inset-0 z-[45] bg-[rgba(2,6,10,.72)] backdrop-blur-[3px]" onClick={onClose} aria-hidden="true" />
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Account Growth"
          style={PANEL_PALETTE}
          className="fixed z-[46] inset-2 sm:inset-4 lg:inset-y-6 lg:left-1/2 lg:-translate-x-1/2 lg:w-[min(1320px,calc(100vw-48px))] flex flex-col rounded-[16px] border border-ds-line3 bg-ds-bg text-ds-text shadow-[0_0_0_1px_rgba(233,189,98,.08),0_30px_90px_rgba(0,0,0,.7)] overflow-hidden"
        >
          {/* Gold hairline — the same accent the portal's feature cards carry. */}
          <span aria-hidden="true" className="absolute inset-x-0 top-0 h-[2px] bg-[linear-gradient(90deg,transparent,rgba(233,189,98,.85),transparent)]" />
          <div className="flex items-start justify-between gap-4 px-4 sm:px-7 pt-5 sm:pt-6 pb-4 border-b border-ds-line shrink-0 bg-[radial-gradient(120%_180%_at_0%_0%,rgba(233,189,98,.10),transparent_55%),linear-gradient(180deg,rgb(14_28_41),rgb(10_21_31))]">
            <div className="min-w-0">
              <p className="text-[10.5px] tracking-[.22em] uppercase text-ds-gold font-bold">Social Media</p>
              <h2 className="mt-1.5 text-[24px] sm:text-[26px] font-bold tracking-[-.02em] text-ds-text">Account Growth</h2>
              <p className="mt-1.5 text-[13px] leading-[1.55] text-ds-t2 max-w-[760px] [text-wrap:pretty]">
                Followers, views and engagement across every channel we track. Each tab says where
                its own numbers come from; a dash is never a zero.
              </p>
            </div>
            <button
              ref={focusClose}
              type="button"
              onClick={onClose}
              aria-label="Close Account Growth"
              className="shrink-0 inline-flex items-center justify-center h-9 w-9 rounded-full border border-ds-line3 bg-ds-inset text-ds-t5 text-[18px] leading-none hover:text-ds-gold hover:border-ds-gold/60 transition-colors"
            >
              ×
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-7 pt-3 pb-7">
            <GrowthView tab={tab} onSelect={setTab} />
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
