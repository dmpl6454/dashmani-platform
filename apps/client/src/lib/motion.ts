"use client";
import { useEffect, useState } from "react";

// The website's motion vocabulary (apps/web ChannelSurf): primary buttons drift
// toward the cursor and spring back, cards tilt under it, big numbers count up.
// Every effect is skipped under prefers-reduced-motion and on coarse pointers.

export function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
export function finePointer(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

/** Magnetic button: call from onMouseMove; `unmagnet` from onMouseLeave. */
export function magnet(e: { currentTarget: HTMLElement; clientX: number; clientY: number }) {
  if (reducedMotion()) return;
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  el.style.transform = `translate(${((e.clientX - r.left - r.width / 2) * 0.18).toFixed(1)}px,${((e.clientY - r.top - r.height / 2) * 0.28).toFixed(1)}px)`;
}
export function unmagnet(e: { currentTarget: HTMLElement }) {
  e.currentTarget.style.transform = "";
}

/** Card tilt toward the cursor, as on the site's Work cards. */
export function tilt(el: HTMLElement, clientX: number, clientY: number, deg = 5) {
  if (reducedMotion()) return;
  const r = el.getBoundingClientRect();
  const px = (clientX - r.left) / r.width - 0.5;
  const py = (clientY - r.top) / r.height - 0.5;
  el.style.transform = `perspective(900px) rotateY(${(px * deg).toFixed(2)}deg) rotateX(${(-py * deg).toFixed(2)}deg) translateY(-3px)`;
}
export function untilt(el: HTMLElement) {
  el.style.transform = "";
}

/** Counts from 0 to `target` with the site's ease-out cubic; jumps straight there under reduced motion. */
export function useCountUp(target: number, duration = 1200): number {
  const [n, setN] = useState(reducedMotion() ? target : 0);
  useEffect(() => {
    if (!Number.isFinite(target)) { setN(target); return; }
    if (reducedMotion()) { setN(target); return; }
    let raf = 0;
    const t0 = performance.now();
    const f = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      setN(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(f);
    };
    raf = requestAnimationFrame(f);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return n;
}
