"use client";

import { useEffect, useRef } from "react";

// PAGE-LEVEL backdrop, ported from the two `position:fixed; z-index:-1` layers that sit
// at the root of the source design (Careers.dc.html) — ABOVE the nav, outside any view.
// They are therefore visible on every page (jobs list, role detail/apply, internship),
// not just behind the hero:
//
//   1. Antigravity bubbles — two parallax depths of dots rising up the whole viewport.
//   2. A gradient wash — a radial vignette plus horizontal/vertical edge gradients that
//      tint the page's edges faintly blue.
//
// Both are decorative and pointer-events:none. Values below are transcribed 1:1 from the
// source (exact left%, size, sway, duration, negative delay per dot) rather than
// generated, so the drift pattern matches the design exactly.

interface Dot {
  left: string;
  size: number;
  /** true → outlined ring, false → filled dot */
  ring: boolean;
  color: string;
  sway: number;
  dur: number;
  delay: number;
}

// Near layer — smaller, subtler, follows the pointer with the shallower parallax.
const AG_NEAR: Dot[] = [
  { left: "22.28%", size: 5.6, ring: false, color: "rgba(11,15,58,0.1)", sway: -5, dur: 53.6, delay: -25.9 },
  { left: "48.45%", size: 6.0, ring: true, color: "rgba(11,15,58,0.1)", sway: -4, dur: 40.9, delay: -33.9 },
  { left: "35.37%", size: 9.9, ring: true, color: "rgba(19,56,190,0.16)", sway: -9, dur: 52.8, delay: -31.6 },
  { left: "80.89%", size: 7.4, ring: false, color: "rgba(11,15,58,0.1)", sway: -15, dur: 46.0, delay: -36.0 },
  { left: "40.42%", size: 6.9, ring: false, color: "rgba(11,15,58,0.1)", sway: 3, dur: 39.5, delay: -5.1 },
  { left: "59.23%", size: 6.7, ring: true, color: "rgba(11,15,58,0.1)", sway: -14, dur: 46.7, delay: -0.4 },
  { left: "16.67%", size: 5.3, ring: false, color: "rgba(19,56,190,0.16)", sway: -16, dur: 53.7, delay: -32.5 },
  { left: "76.63%", size: 9.1, ring: false, color: "rgba(11,15,58,0.1)", sway: -14, dur: 34.2, delay: -26.8 },
  { left: "62.54%", size: 9.7, ring: true, color: "rgba(19,56,190,0.16)", sway: 0, dur: 52.1, delay: -35.7 },
  { left: "15.04%", size: 7.0, ring: true, color: "rgba(11,15,58,0.1)", sway: 12, dur: 37.0, delay: -5.4 },
  { left: "35.06%", size: 7.2, ring: true, color: "rgba(11,15,58,0.1)", sway: -19, dur: 43.4, delay: -14.6 },
  { left: "3.76%", size: 8.0, ring: true, color: "rgba(19,56,190,0.16)", sway: 4, dur: 47.7, delay: -12.6 },
  { left: "85.32%", size: 5.8, ring: false, color: "rgba(11,15,58,0.1)", sway: 19, dur: 37.0, delay: -28.3 },
  { left: "59.92%", size: 5.7, ring: true, color: "rgba(19,56,190,0.16)", sway: -3, dur: 41.4, delay: -2.3 },
  { left: "16.93%", size: 6.4, ring: false, color: "rgba(11,15,58,0.1)", sway: 0, dur: 43.8, delay: -25.9 },
  { left: "76.60%", size: 8.9, ring: true, color: "rgba(11,15,58,0.1)", sway: 16, dur: 39.3, delay: -34.3 },
];

// Far layer — larger and stronger, drifts opposite the pointer for depth.
const AG_FAR: Dot[] = [
  { left: "68.02%", size: 11.6, ring: true, color: "rgba(19,56,190,0.24)", sway: 12, dur: 29.7, delay: -25.1 },
  { left: "82.37%", size: 15.2, ring: true, color: "rgba(11,15,58,0.16)", sway: 28, dur: 32.3, delay: -27.4 },
  { left: "63.67%", size: 13.4, ring: true, color: "rgba(19,56,190,0.24)", sway: -36, dur: 26.0, delay: -18.7 },
  { left: "82.65%", size: 16.6, ring: false, color: "rgba(11,15,58,0.16)", sway: -12, dur: 33.5, delay: -2.2 },
  { left: "79.00%", size: 14.7, ring: true, color: "rgba(11,15,58,0.16)", sway: 12, dur: 23.6, delay: -8.7 },
  { left: "70.62%", size: 14.8, ring: false, color: "rgba(19,56,190,0.24)", sway: 31, dur: 34.7, delay: -9.1 },
  { left: "24.18%", size: 16.3, ring: true, color: "rgba(19,56,190,0.24)", sway: 6, dur: 34.2, delay: -21.0 },
  { left: "9.20%", size: 16.6, ring: false, color: "rgba(19,56,190,0.24)", sway: -22, dur: 26.2, delay: -5.0 },
  { left: "77.45%", size: 11.3, ring: false, color: "rgba(11,15,58,0.16)", sway: -8, dur: 31.0, delay: -1.9 },
  { left: "37.66%", size: 16.3, ring: true, color: "rgba(19,56,190,0.24)", sway: 25, dur: 35.4, delay: -9.2 },
  { left: "90.30%", size: 10.0, ring: true, color: "rgba(11,15,58,0.16)", sway: 42, dur: 23.0, delay: -16.2 },
];

function dotStyle(d: Dot, scale = 1): React.CSSProperties {
  return {
    left: d.left,
    width: `${d.size * scale}px`,
    height: `${d.size * scale}px`,
    background: d.ring ? "transparent" : d.color,
    border: d.ring ? `1.5px solid ${d.color}` : "none",
    ["--sway" as string]: `${d.sway}px`,
    animationDuration: `${d.dur}s`,
    animationDelay: `${d.delay}s`,
  };
}

export default function PageBackdrop() {
  const agRef = useRef<HTMLDivElement>(null);

  // Pointer parallax — writes --agx/--agy (both in -1..1) which the two layers below
  // multiply by different offsets to separate their depths.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const el = agRef.current;
      if (!el) return;
      el.style.setProperty("--agx", ((e.clientX / window.innerWidth) * 2 - 1).toFixed(3));
      el.style.setProperty("--agy", ((e.clientY / window.innerHeight) * 2 - 1).toFixed(3));
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  return (
    <>
      <div className="ds-page-ag" data-ag="1" aria-hidden="true" ref={agRef}>
        <div className="ds-page-ag-near">
          {AG_NEAR.map((d, i) => (
            <span key={i} style={dotStyle(d)} />
          ))}
        </div>
        <div className="ds-page-ag-far">
          {AG_FAR.map((d, i) => (
            <span key={i} style={dotStyle(d)} />
          ))}
        </div>
      </div>
      <div className="ds-page-wash" aria-hidden="true">
        <div className="x" />
        <div className="y" />
      </div>
    </>
  );
}
