"use client";

import { useEffect, useRef, useState } from "react";

// Full-page preloader ported from the claude.ai/design prototype's `_initLoader` /
// `_startMorph` / `_dsLoop` / `dsSurface` state machine — same liquid-fill wave math,
// same two-piece glass "S" mark, same brim-full split timing, adapted from a
// class-component rAF loop to hooks. This is the exact choreography (not an
// approximation): the mark holds and fills/drains on a loop; once fonts+page are ready
// (or a timeout), it waits for the NEXT full brim (two complete fill/drain cycles) so
// the split always lands on a "full" moment; the mark's two halves nudge apart
// (`pieceL`/`pieceR`), then the curtains slide the whole thing off in a big diagonal
// translate, revealing the page. `loaderSpeed`/`loaderWave` match the design tool's own
// default prop values (2.25 / 17) — the speed the original preview actually ran at.
//
// Never blocks content: skipped entirely under `prefers-reduced-motion`, and a 14s hard
// timeout unmounts unconditionally regardless of anything else.

const LOADER_SPEED = 2.25;
const LOADER_WAVE = 17;
const CYCLE_MS = 4200 / LOADER_SPEED;
const VBW = 898.03;
const A_TOP = 0.0, A_BOT = 983.7; // right half: rising
const B_TOP = 360.4, B_BOT = 1024.0; // left half: falling
const NPTS = 64, X0 = -60, X1 = 960;

const IN_HOLD_MS = 90;
const SPLIT_TO_EXIT_MS = 300;
const EXIT_TO_DONE_MS = 880; // 1180ms total from split to fully gone
const KILL_TIMEOUT_MS = 2800; // force "ready" if fonts/load never resolve
const HARD_TIMEOUT_MS = 14000; // absolute failsafe — always unmounts by here

function surfacePath(y: number, amp: number, cycles: number, phase: number, below: boolean) {
  let d = "";
  for (let i = 0; i < NPTS; i++) {
    const x = X0 + (X1 - X0) * (i / (NPTS - 1));
    const yy = y + amp * Math.sin(cycles * (x / VBW) * Math.PI * 2 + phase);
    d += (i ? "L" : "M") + x.toFixed(1) + "," + yy.toFixed(1);
  }
  d += below ? `L${X1},1300L${X0},1300` : `L${X1},-300L${X0},-300`;
  return d + "Z";
}

type Phase = "in" | "hold" | "split" | "exit";

export default function HeroLoader({ onDone }: { onDone?: () => void }) {
  const [visible, setVisible] = useState(true);
  const [phase, setPhase] = useState<Phase>("in");
  const [loaderFinal, setLoaderFinal] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    let reduced = false;
    try {
      reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      // ignore
    }
    if (reduced) {
      setVisible(false);
      onDone?.();
      return;
    }

    const timers: ReturnType<typeof setTimeout>[] = [];
    const setT = (fn: () => void, ms: number) => {
      const id = setTimeout(fn, ms);
      timers.push(id);
      return id;
    };

    setT(() => setPhase("hold"), IN_HOLD_MS);

    let splitFired = false;
    const fireSplit = () => {
      if (splitFired) return;
      splitFired = true;
      setLoaderFinal(true);
      setPhase("split");
      setT(() => setPhase("exit"), SPLIT_TO_EXIT_MS);
      setT(() => {
        setVisible(false);
        onDone?.();
      }, SPLIT_TO_EXIT_MS + EXIT_TO_DONE_MS);
    };

    let wantOpen = false;
    let opened = false;
    const open = () => {
      if (opened) return;
      opened = true;
      wantOpen = true;
    };

    const fonts = document.fonts?.ready ?? Promise.resolve();
    const loaded =
      document.readyState === "complete"
        ? Promise.resolve()
        : new Promise<void>((res) => window.addEventListener("load", () => res(), { once: true }));
    Promise.all([fonts, loaded]).then(open, open);
    setT(open, KILL_TIMEOUT_MS);
    setT(() => {
      setVisible(false);
      onDone?.();
    }, HARD_TIMEOUT_MS);

    const start = performance.now();
    let prevFills: number | undefined;
    let localFinal = false;

    const tick = (now: number) => {
      if (splitFired) {
        rafRef.current = null;
        return;
      }
      const el = now - start;
      const t = (el % CYCLE_MS) / CYCLE_MS;
      const filling = t < 0.5;
      const u = (t % 0.5) / 0.5;
      const c = LOADER_WAVE + 2;
      const aFrom = A_BOT + c, aTo = A_TOP - c;
      const bFrom = B_TOP - c, bTo = B_BOT + c;
      const ph = t * Math.PI * 4;
      const da = surfacePath(aFrom + (aTo - aFrom) * u, LOADER_WAVE, 1.6, ph, filling);
      const db = surfacePath(bFrom + (bTo - bFrom) * u, LOADER_WAVE, 1.6, ph + 2.1, !filling);
      const fills = Math.floor(el / CYCLE_MS + 0.5);

      if (fills >= 1 && wantOpen && !localFinal) {
        localFinal = true;
        setLoaderFinal(true);
      }
      if (fills >= 2 && wantOpen && prevFills !== undefined && fills > prevFills) {
        prevFills = fills;
        fireSplit();
        return;
      }
      prevFills = fills;

      const svg = svgRef.current;
      if (svg) {
        svg.querySelectorAll('[data-loader-liquid="a"]').forEach((el) => el.setAttribute("d", da));
        svg.querySelectorAll('[data-loader-liquid="b"]').forEach((el) => el.setAttribute("d", db));
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      timers.forEach(clearTimeout);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!visible) return null;

  const split = phase === "split" || phase === "exit";
  const exiting = phase === "exit";
  const markFade = phase === "in" ? 0 : 1;
  const markScale = phase === "in" ? "scale(0.88)" : exiting ? "scale(1.14)" : "scale(1)";
  const morphFade = phase === "in" || phase === "hold" ? 1 : 0;
  const glassFade = loaderFinal ? 0 : 1;
  const splitFade = split ? 1 : 0;
  const pieceL = split ? "translate(-46px,26px)" : "translate(0,0)";
  const pieceR = split ? "translate(46px,-26px)" : "translate(0,0)";
  const curtainL = exiting ? "translate(-1500px,320px)" : "translate(0,0)";
  const curtainR = exiting ? "translate(1500px,-320px)" : "translate(0,0)";

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading"
      style={{ position: "fixed", inset: 0, zIndex: 90, pointerEvents: "none", overflow: "hidden" }}
    >
      <svg
        ref={svgRef}
        viewBox="0 0 2000 1200"
        preserveAspectRatio="xMidYMid slice"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }}
      >
        <defs>
          <path
            id="ds-loader-pa"
            d="M 187.1,0.6 C 149.4,3.3 95.9,20.5 65.5,39.7 C -40.4,106.9 -12.5,231.7 137,359 C 186.9,401.5 228.6,428.6 327.7,482.7 C 418.2,532.1 464.6,560.7 504.9,592 C 592.6,660 638.7,738 643.8,827 C 645.5,858.5 640.7,885.4 624.3,934 C 617,955.6 615,964 615.6,970 C 618.8,1005.6 694.5,968.2 760,898.7 C 853.2,799.7 903,659.5 897.6,510.9 C 894.3,415.4 860.6,324.6 798.7,243.8 C 775.2,213.1 734.6,171.5 702.8,145.4 C 624.3,81.1 519.4,33.5 418,16.1 C 408.7,14.4 395.8,11.9 389.3,10.5 C 358.3,3.3 348.6,1.7 330.8,0.6 C 318.6,-0.2 197.9,-0.2 187.1,0.6 Z"
          />
          <path
            id="ds-loader-pb"
            d="M 19.4,361.7 C 8.1,365.8 2.6,379.7 0.8,408.1 C -0.8,433.6 0.3,867.4 1.9,876.7 C 7.8,909 22.7,928.6 58.7,951.1 C 102.1,978.3 149.4,996.6 224.4,1015.1 C 255.9,1022.9 278.7,1024.6 344.7,1023.8 C 393.8,1023.3 407.1,1021.7 432.3,1013.5 C 482.9,997 517.1,970 541.1,927.6 C 600.7,822.5 561.7,721.8 422.4,620.4 C 381.9,591 338.5,564.3 240.8,509 C 159,462.6 126.5,439.8 73.6,391.2 C 43.8,363.9 31.6,357.2 19.4,361.7 Z"
          />
          <clipPath id="ds-loader-ca"><use href="#ds-loader-pa" /></clipPath>
          <clipPath id="ds-loader-cb"><use href="#ds-loader-pb" /></clipPath>
          <clipPath id="ds-loader-all"><use href="#ds-loader-pa" /><use href="#ds-loader-pb" /></clipPath>
          <filter id="ds-loader-haze" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="160" />
          </filter>
          <linearGradient id="ds-loader-glass" x1="0.15" y1="0" x2="0.7" y2="1">
            <stop offset="0" stopColor="#CFE0F7" stopOpacity="0.5" />
            <stop offset="0.55" stopColor="#B0C8EC" stopOpacity="0.48" />
            <stop offset="1" stopColor="#8CADE0" stopOpacity="0.46" />
          </linearGradient>
          <linearGradient id="ds-loader-edge" x1="0" y1="0" x2="0.9" y2="1">
            <stop offset="0" stopColor="#DFEAFA" stopOpacity="0.66" />
            <stop offset="1" stopColor="#8DAEE2" stopOpacity="0.34" />
          </linearGradient>
          <linearGradient id="ds-loader-liquid" gradientUnits="userSpaceOnUse" x1="90" y1="0" x2="470" y2="1024">
            <stop offset="0" stopColor="#3B77E8" />
            <stop offset="1" stopColor="#0B45BB" />
          </linearGradient>
        </defs>

        {/* Left curtain — carries the left glass piece (pb) once split. */}
        <g style={{ transform: curtainL, transition: "transform .95s cubic-bezier(.76,0,.24,1)" }}>
          <path
            d="M-400 -400 L700 -400 C800 200 890 470 925.9 571 C943 582 973.8 601.8 1001.1 619.4 C1013.4 628.2 1024.4 639.2 1028.4 650.2 C1032.3 659 1034.5 663.4 1034.5 670 C1034.3 681 1031 692 1024.2 703 C1010 800 990 1100 1000 1600 L-400 1600 Z"
            fill="var(--paper, #F5F7FF)"
          />
          <g transform="translate(1000,600) scale(0.22) translate(-449,-512)">
            <g style={{ transform: markScale, transformOrigin: "449px 512px", opacity: markFade, transition: "transform .62s cubic-bezier(.16,1,.3,1), opacity .5s cubic-bezier(.16,1,.3,1)" }}>
              <g style={{ transform: pieceL, opacity: splitFade, transition: "transform .66s cubic-bezier(.76,0,.24,1), opacity .3s ease" }}>
                <use href="#ds-loader-pb" fill="url(#ds-loader-glass)" style={{ opacity: glassFade, transition: "opacity .7s ease" }} />
                <g clipPath="url(#ds-loader-cb)"><path data-loader-liquid="b" fill="url(#ds-loader-liquid)" /></g>
                <use href="#ds-loader-pb" fill="none" stroke="url(#ds-loader-edge)" strokeWidth={6} style={{ opacity: glassFade, transition: "opacity .7s ease" }} />
              </g>
            </g>
          </g>
        </g>

        {/* Right curtain — carries the right glass piece (pa) once split. */}
        <g style={{ transform: curtainR, transition: "transform .95s cubic-bezier(.76,0,.24,1)" }}>
          <path
            d="M700 -400 L2400 -400 L2400 1600 L1000 1600 C990 1100 1010 800 1024.2 703 C1031 692 1034.3 681 1034.5 670 C1034.5 663.4 1032.3 659 1028.4 650.2 C1024.4 639.2 1013.4 628.2 1001.1 619.4 C973.8 601.8 943 582 925.9 571 C890 470 800 200 700 -400 Z"
            fill="var(--paper, #F5F7FF)"
          />
          <g transform="translate(1000,600) scale(0.22) translate(-449,-512)">
            <g style={{ transform: markScale, transformOrigin: "449px 512px", opacity: markFade, transition: "transform .62s cubic-bezier(.16,1,.3,1), opacity .5s cubic-bezier(.16,1,.3,1)" }}>
              <g style={{ transform: pieceR, opacity: splitFade, transition: "transform .66s cubic-bezier(.76,0,.24,1), opacity .3s ease" }}>
                <use href="#ds-loader-pa" fill="url(#ds-loader-glass)" style={{ opacity: glassFade, transition: "opacity .7s ease" }} />
                <g clipPath="url(#ds-loader-ca)"><path data-loader-liquid="a" fill="url(#ds-loader-liquid)" /></g>
                <use href="#ds-loader-pa" fill="none" stroke="url(#ds-loader-edge)" strokeWidth={6} style={{ opacity: glassFade, transition: "opacity .7s ease" }} />
              </g>
            </g>
          </g>
        </g>

        {/* Unified mark, visible only while whole (before the split). */}
        <g style={{ opacity: morphFade, transition: "opacity .35s ease" }} aria-hidden="true">
          <g transform="translate(1000,600) scale(0.22) translate(-449,-512)">
            <g style={{ transform: markScale, transformOrigin: "449px 512px", transition: "transform .62s cubic-bezier(.16,1,.3,1)" }}>
              <g style={{ opacity: glassFade, transition: "opacity .7s ease" }}>
                <g clipPath="url(#ds-loader-all)">
                  <rect width={898.03} height={1024} fill="#E9F0FD" />
                  <circle cx={300} cy={300} r={420} fill="#D5E4FC" opacity={0.7} filter="url(#ds-loader-haze)" />
                  <circle cx={700} cy={820} r={360} fill="#7DA2DB" opacity={0.38} filter="url(#ds-loader-haze)" />
                </g>
                <use href="#ds-loader-pa" fill="url(#ds-loader-glass)" />
                <use href="#ds-loader-pb" fill="url(#ds-loader-glass)" />
              </g>
              <g clipPath="url(#ds-loader-ca)"><path data-loader-liquid="a" fill="url(#ds-loader-liquid)" /></g>
              <g clipPath="url(#ds-loader-cb)"><path data-loader-liquid="b" fill="url(#ds-loader-liquid)" /></g>
              <use href="#ds-loader-pa" fill="none" stroke="url(#ds-loader-edge)" strokeWidth={6} style={{ opacity: glassFade, transition: "opacity .7s ease" }} />
              <use href="#ds-loader-pb" fill="none" stroke="url(#ds-loader-edge)" strokeWidth={6} style={{ opacity: glassFade, transition: "opacity .7s ease" }} />
            </g>
          </g>
        </g>
      </svg>
    </div>
  );
}
