"use client";

import { useEffect, useRef, type RefObject } from "react";

// Hero atmosphere, ported from the claude.ai/design prototype's `_initFlowField` +
// antigravity pointer-parallax wiring: an isometric "cube monument" canvas that floats
// above the headline and lifts cubes near the cursor, a cursor-trail canvas that paints
// ephemeral icon glyphs, a panning dot-grid background, floating scrambled text, and two
// depths of rising "antigravity" dots. All decorative — gated behind
// `prefers-reduced-motion` (renders one static frame) and an IntersectionObserver on the
// hero (pauses off-screen).
//
// Split into a hook (`useHeroFX`) that owns the canvases + physics, and a `<HeroBackdrop>`
// component that renders the grid/noise/antigravity/trail layer — so the cube canvas
// itself can be placed inside the hero's centered content column (it takes real layout
// space above the headline) while the rest stays an absolutely-positioned background.

const NOISE_WORDS = [
  "REVISE THE DECK", "EOD?", "CTR -12%", "FINAL_FINAL_v7", "QUICK CALL?", "ASAP",
  "SCOPE CREEP", "REPLY ALL", "CAN YOU JUST", "DEADLINE MOVED", "ONE MORE ROUND",
  "APPROVALS PENDING", "URGENT", "SLIGHT TWEAK", "BUDGET CUT", "GOING LIVE TONIGHT",
  "PING ME", "ANOTHER VERSION", "BY MONDAY?", "LOOP HIM IN",
];

function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

const rand = seededRandom(42);
const NOISE_ITEMS = NOISE_WORDS.map((word, i) => ({
  word,
  left: (rand() * 90 + 4).toFixed(2),
  top: (rand() * 78 + 10).toFixed(2),
  dx: Math.round((rand() - 0.5) * 1400),
  dy: Math.round((rand() - 0.5) * 800),
  r: Math.round((rand() - 0.5) * 100),
  delay: (i * 0.04).toFixed(2),
  drift: (13 + rand() * 14).toFixed(1),
}));

// Individual grid squares that fade blue in/out on staggered clocks — the "cell
// glow" layer, distinct from the isometric cube canvas above the headline. Exact
// cell coordinates (in --cell units), alpha, duration, and delay from the source.
const CELL_GLOW = [
  { left: 3, top: 1, alpha: 0.16, dur: 5.5, delay: 0.0 },
  { left: 7, top: 0, alpha: 0.09, dur: 6.9, delay: 0.97 },
  { left: 11, top: 2, alpha: 0.09, dur: 8.3, delay: 1.94 },
  { left: 2, top: 3, alpha: 0.09, dur: 9.7, delay: 1.86 },
  { left: 9, top: 1, alpha: 0.16, dur: 5.5, delay: 2.83 },
  { left: 14, top: 2, alpha: 0.09, dur: 6.9, delay: 3.8 },
  { left: 5, top: 4, alpha: 0.09, dur: 8.3, delay: 3.72 },
  { left: 12, top: 0, alpha: 0.09, dur: 9.7, delay: 4.69 },
  { left: 1, top: 2, alpha: 0.16, dur: 5.5, delay: 5.66 },
  { left: 8, top: 4, alpha: 0.09, dur: 6.9, delay: 5.58 },
  { left: 16, top: 1, alpha: 0.09, dur: 8.3, delay: 6.55 },
  { left: 4, top: 5, alpha: 0.09, dur: 9.7, delay: 7.52 },
  { left: 10, top: 3, alpha: 0.16, dur: 5.5, delay: 7.44 },
  { left: 13, top: 5, alpha: 0.09, dur: 6.9, delay: 8.41 },
  { left: 6, top: 0, alpha: 0.09, dur: 8.3, delay: 9.38 },
  { left: 15, top: 4, alpha: 0.09, dur: 9.7, delay: 9.3 },
  { left: 0, top: 3, alpha: 0.16, dur: 5.5, delay: 10.27 },
  { left: 17, top: 1, alpha: 0.09, dur: 6.9, delay: 11.24 },
  { left: 9, top: 5, alpha: 0.09, dur: 8.3, delay: 11.16 },
  { left: 3, top: 4, alpha: 0.09, dur: 9.7, delay: 12.13 },
  { left: 12, top: 2, alpha: 0.16, dur: 5.5, delay: 13.1 },
  { left: 7, top: 3, alpha: 0.09, dur: 6.9, delay: 13.02 },
];

// NOTE: the rising "antigravity" bubbles are NOT here — in the source design they're a
// root-level fixed layer covering the whole page, so they live in PageBackdrop.tsx and
// are mounted once in layout.tsx for every route.

export function HeroBackdrop({
  trailCanvasRef,
}: {
  trailCanvasRef: RefObject<HTMLCanvasElement>;
}) {
  return (
    <>
      <div className="ds-hero-grid" aria-hidden="true">
        <div className="ds-hero-grid-lines" />
        <div className="ds-hero-cellglow">
          {CELL_GLOW.map((c, i) => (
            <span
              key={i}
              style={{
                left: `calc(${c.left} * var(--cell))`,
                top: `calc(${c.top} * var(--cell))`,
                background: `rgba(19,56,190,${c.alpha})`,
                animationDuration: `${c.dur}s`,
                animationDelay: `${c.delay}s`,
              }}
            />
          ))}
        </div>
        <div className="ds-hero-noise">
          {NOISE_ITEMS.map((n, i) => (
            <span
              key={i}
              style={
                {
                  left: `${n.left}%`,
                  top: `${n.top}%`,
                  "--dx": `${n.dx}px`,
                  "--dy": `${n.dy}px`,
                  "--r": `${n.r}deg`,
                  animationDelay: `${n.delay}s, ${n.delay}s`,
                  animationDuration: `1.9s, ${n.drift}s`,
                } as React.CSSProperties
              }
            >
              {n.word}
            </span>
          ))}
        </div>
        <div className="ds-hero-fade" />
        <div className="ds-hero-fade-edges" />
      </div>
      <canvas
        ref={trailCanvasRef}
        aria-hidden="true"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 0 }}
      />
    </>
  );
}

const ICONS: Array<(c: CanvasRenderingContext2D) => void> = [
  (c) => {
    c.beginPath();
    c.moveTo(0, 5.4);
    c.bezierCurveTo(-7.4, -0.6, -5.2, -6.6, -1.6, -6.6);
    c.bezierCurveTo(-0.4, -6.6, 0, -5.6, 0, -5.2);
    c.bezierCurveTo(0, -5.6, 0.4, -6.6, 1.6, -6.6);
    c.bezierCurveTo(5.2, -6.6, 7.4, -0.6, 0, 5.4);
    c.closePath();
    c.stroke();
  },
  (c) => {
    c.beginPath();
    c.moveTo(-2.4, -0.6);
    c.lineTo(-0.2, -6.4);
    c.quadraticCurveTo(1.8, -6.8, 1.6, -4.4);
    c.lineTo(1.2, -1.4);
    c.lineTo(5.4, -1.4);
    c.quadraticCurveTo(7, -1.4, 6.6, 0.2);
    c.lineTo(5.4, 4.8);
    c.quadraticCurveTo(5, 6.2, 3.4, 6.2);
    c.lineTo(-2.4, 6.2);
    c.closePath();
    c.stroke();
    c.beginPath();
    c.rect(-6.4, -0.6, 4, 6.8);
    c.stroke();
  },
  (c) => {
    c.beginPath();
    c.moveTo(-5.4, -5.6);
    c.lineTo(5.4, -5.6);
    c.quadraticCurveTo(7, -5.6, 7, -4);
    c.lineTo(7, 1.4);
    c.quadraticCurveTo(7, 3, 5.4, 3);
    c.lineTo(-1.4, 3);
    c.lineTo(-4.6, 6.2);
    c.lineTo(-4.6, 3);
    c.lineTo(-5.4, 3);
    c.quadraticCurveTo(-7, 3, -7, 1.4);
    c.lineTo(-7, -4);
    c.quadraticCurveTo(-7, -5.6, -5.4, -5.6);
    c.closePath();
    c.stroke();
  },
  (c) => {
    c.beginPath();
    c.arc(5, -5, 2.2, 0, 6.2832);
    c.stroke();
    c.beginPath();
    c.arc(-5, 0, 2.2, 0, 6.2832);
    c.stroke();
    c.beginPath();
    c.arc(5, 5, 2.2, 0, 6.2832);
    c.stroke();
    c.beginPath();
    c.moveTo(-3.1, -1);
    c.lineTo(3.1, -4);
    c.moveTo(-3.1, 1);
    c.lineTo(3.1, 4);
    c.stroke();
  },
  (c) => {
    c.beginPath();
    c.arc(-1.2, -1.2, 4.8, 0, 6.2832);
    c.stroke();
    c.beginPath();
    c.moveTo(2.3, 2.3);
    c.lineTo(6.4, 6.4);
    c.stroke();
  },
];
const TRAIL_COLORS = ["#1338BE", "rgba(19,56,190,0.7)", "#0B0F3A", "rgba(11,15,58,0.65)"];

interface TrailIcon {
  hx: number; hy: number; vis: number; ox: number; oy: number; push: number;
  swirl: number; lag: number; t: number; sp: number; ph: number; pulse: number;
  size: number; rot0: number; ic: number; col: string;
}
interface Cube {
  i: number; j: number; k: number; h: number; acc: boolean | number; fl: number;
  pl: number; lift: number; lv: number; ph: number;
}
interface Floater {
  fx: number; fy: number; sc: number; ph: number; sp: number; acc: boolean;
  op: number; delay: number; lift: number;
}

export function useHeroFX(heroRef: RefObject<HTMLElement>, playing: boolean) {
  const cubeCanvasRef = useRef<HTMLCanvasElement>(null);
  const trailCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const hero = heroRef.current;
    const cubeCv = cubeCanvasRef.current;
    const trailCv = trailCanvasRef.current;
    if (!hero || !cubeCv || !trailCv) return;

    let reduced = false;
    try {
      reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      // ignore
    }

    const cctx = cubeCv.getContext("2d");
    const tctx = trailCv.getContext("2d");
    if (!cctx || !tctx) return;

    let W = 0, H = 0, CW = 0, CH = 0, dpr = Math.min(window.devicePixelRatio || 1, 2), t = 0;
    let mx = -1e4, my = -1e4, cmx = -1e4, cmy = -1e4;
    let dvx = 0, dvy = 0, idleT = 0, active = false;
    let vmx = -1e4, vmy = -1e4, ripple = 0;
    // Last known pointer position in VIEWPORT coords. `mx/my` (hero-relative) and
    // `cmx/cmy` (cube-canvas-relative) go stale the moment the page scrolls without the
    // mouse moving: the hero slides under a stationary cursor and no mousemove fires, so
    // there is nothing to recompute them from. Keeping the raw client coords lets us
    // re-derive both on scroll. See `applyPointer`.
    let lastCX = -1e4, lastCY = -1e4;
    let raf: number | null = null;
    let lastTime = performance.now();
    // Repaint budgeting for the cube layer. Redrawing ~200 gradient-filled cubes plus the
    // beams and sparks is the single most expensive thing on this page, and it competes
    // directly with scrolling: painting it on every rAF tick measured a p95 frame time of
    // 14-21ms and 5-7 dropped frames per scroll pass, against 7.1ms and zero when the
    // layer was static. Two limits fix that without going back to a frozen hero:
    //   1. cap it to ~30fps — the bob/beam/spark motion is slow and subtle enough that
    //      halving its rate is imperceptible, and rAF can run far above 60Hz anyway;
    //   2. skip it entirely while a scroll is in flight AND the cursor is outside the
    //      hero, i.e. someone reading the listings. When the cursor IS in the hero the
    //      full rate is kept, because that is exactly the cursor-follows-scroll behaviour
    //      the hero is supposed to have.
    const CUBE_FRAME_MS = 33;
    const SCROLL_QUIET_MS = 140;
    let cubeAccum = CUBE_FRAME_MS; // paint on the very first tick
    let lastScrollAt = -1e9;

    // ── cursor-trail icons ──
    const RING = 152, BAND = 62, CLEAR = 52;
    const trail: TrailIcon[] = [];
    const seedIcons = () => {
      trail.length = 0;
      const n = Math.max(170, Math.min(430, Math.round((W * H) / 3400)));
      for (let i = 0; i < n; i++) {
        trail.push({
          hx: (Math.random() * 1.16 - 0.08) * W,
          hy: (Math.random() * 1.16 - 0.08) * H,
          vis: 0, ox: 0, oy: 0,
          push: 0.72 + Math.random() * 0.7,
          swirl: (Math.random() - 0.5) * 2,
          lag: 0.8 + Math.random() * 0.5,
          t: Math.random() * 100,
          sp: 0.005 + Math.random() * 0.01,
          ph: Math.random() * 6.28,
          pulse: 1.6 + Math.random() * 1.4,
          size: 0.5 + Math.random() * 0.38,
          rot0: (Math.random() - 0.5) * 0.44,
          ic: i % ICONS.length,
          col: TRAIL_COLORS[(Math.random() * TRAIL_COLORS.length) | 0],
        });
      }
    };

    // ── cube monument ──
    const cubes: Cube[] = [];
    const floaters: Floater[] = [];
    const addCube = (i: number, j: number, k: number, o: Partial<Cube> = {}) =>
      cubes.push({ i, j, k, h: 1, acc: false, fl: 0, pl: 0, lift: 0, lv: 0, ph: (i * 2.1 + j * 3.7 + k * 1.3) % 6.28, ...o });
    const rnd2 = (i: number, j: number) => {
      const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
      return s - Math.floor(s);
    };
    for (let i = 0; i < 9; i++) {
      for (let j = 0; j < 9; j++) {
        const ring = Math.abs(i - 4) + Math.abs(j - 4);
        const r = rnd2(i, j);
        if (ring > 5) continue;
        if (ring === 5 && r < 0.55) continue;
        if (ring === 4 && r < 0.18) continue;
        const hole = ring <= 2 && rnd2(i * 1.7, j * 2.3) > 0.9;
        if (!hole) {
          addCube(i, j, 2, { acc: ring <= 3 && rnd2(i + 3, j + 7) < 0.45 });
          if (ring <= 3 && r > 0.88) addCube(i, j, 3, { acc: rnd2(i + 6, j + 2) < 0.4 });
        }
        if (ring <= 4 && rnd2(i + 5, j + 1) < 0.8) addCube(i, j, 1, { acc: (hole || ring <= 1) && rnd2(i + 2, j + 9) < 0.7 });
        if (ring <= 1) addCube(i, j, 0, { acc: rnd2(i + 8, j + 4) < 0.5 });
      }
    }
    addCube(1.2, 8.4, 0, { pl: 1, h: 0.3 }); addCube(-0.8, 6.5, 0, { pl: 1, h: 0.5 }); addCube(0.3, 9.6, -0.4, { pl: 1, h: 0.25 });
    addCube(8.9, 6.2, 0, { pl: 1, h: 0.4 }); addCube(9.8, 3.1, -0.3, { pl: 1, h: 0.3 }); addCube(7.5, 8.3, -0.5, { pl: 1, h: 0.25 });
    addCube(-1.5, 4.2, 0.6, { fl: 1, h: 0.6 }); addCube(9.2, 0.8, 0.8, { fl: 1, h: 0.6, acc: true });
    addCube(2.2, -1.4, 1.6, { fl: 1, h: 0.5 }); addCube(6.8, -1.8, 1.9, { fl: 1, h: 0.4 });
    cubes.sort((a, b) => a.i + a.j - (b.i + b.j) || a.k - b.k);

    const seedFloaters = () => {
      floaters.length = 0;
      const n = Math.max(9, Math.min(22, Math.round((CW * CH) / 26000)));
      for (let i = 0; i < n; i++) {
        const col = (((i % 5) + Math.random() * 0.8) / 5);
        floaters.push({
          fx: 0.03 + col * 0.94, fy: 0.02 + Math.random() * 0.5,
          sc: 0.3 + Math.random() * 0.42, ph: Math.random() * 6.28,
          sp: 0.45 + Math.random() * 0.55, acc: Math.random() < 0.22,
          op: 0.5 + Math.random() * 0.34, delay: 0.25 + Math.random() * 1.0, lift: 0,
        });
      }
    };

    let gW = -1, gcw = 0, gch = 0, gcd = 0;
    let GR: Record<string, CanvasGradient> | null = null;
    const buildGrads = (cw: number, ch: number, cd: number) => {
      const mk = (x0: number, y0: number, x1: number, y1: number, c0: string, c1: string) => {
        const g = cctx.createLinearGradient(x0, y0, x1, y1);
        g.addColorStop(0, c0);
        g.addColorStop(1, c1);
        return g;
      };
      return {
        rN: mk(0, 0, 0, ch + cd, "#c3c8ef", "#a3a9e0"), rA: mk(0, 0, 0, ch + cd, "#1338be", "#0d2a94"),
        lN: mk(0, 0, 0, ch + cd, "#dfe1f8", "#c3c7ee"), lA: mk(0, 0, 0, ch + cd, "#3a56d0", "#1338be"),
        tN: mk(-cw, -ch, cw, ch, "#ffffff", "#e4e4f9"), tA: mk(-cw, -ch, cw, ch, "#c1cbf5", "#98a7ee"),
        tNH: mk(-cw, -ch, cw, ch, "#ffffff", "#d2d6fb"), tAH: mk(-cw, -ch, cw, ch, "#d3daf8", "#b0bef3"),
      };
    };
    const drawBox = (x: number, y: number, sc: number, dep: number, acc: boolean | number, hot: number, al: number) => {
      if (al <= 0.012 || !GR) return;
      const cw = gcw, ch = gch, full = dep >= gcd - 0.01;
      cctx.globalAlpha = al;
      cctx.save();
      cctx.translate(x, y);
      if (sc !== 1) cctx.scale(sc, sc);
      cctx.lineWidth = 1 / sc;
      cctx.strokeStyle = "rgba(19,56,190,0.10)";
      cctx.fillStyle = full ? (acc ? GR.rA : GR.rN) : acc ? "#0d2a94" : "#aeb4e4";
      cctx.beginPath(); cctx.moveTo(cw, 0); cctx.lineTo(0, ch); cctx.lineTo(0, ch + dep); cctx.lineTo(cw, dep); cctx.closePath();
      cctx.fill(); cctx.stroke();
      cctx.fillStyle = full ? (acc ? GR.lA : GR.lN) : acc ? "#1338be" : "#cfd3f2";
      cctx.beginPath(); cctx.moveTo(-cw, 0); cctx.lineTo(0, ch); cctx.lineTo(0, ch + dep); cctx.lineTo(-cw, dep); cctx.closePath();
      cctx.fill(); cctx.stroke();
      cctx.fillStyle = acc ? (hot > 0.3 ? GR.tAH : GR.tA) : hot > 0.3 ? GR.tNH : GR.tN;
      cctx.beginPath(); cctx.moveTo(0, -ch); cctx.lineTo(cw, 0); cctx.lineTo(0, ch); cctx.lineTo(-cw, 0); cctx.closePath();
      cctx.fill();
      cctx.strokeStyle = hot > 0.3 ? "rgba(150,160,255,0.95)" : "rgba(255,255,255,0.75)";
      cctx.stroke();
      cctx.restore();
      cctx.globalAlpha = 1;
    };

    const csize = () => {
      const r = cubeCv.getBoundingClientRect();
      CW = Math.max(1, r.width);
      CH = Math.max(1, r.height);
      cubeCv.width = Math.round(CW * dpr);
      cubeCv.height = Math.round(CH * dpr);
      cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seedFloaters();
    };

    const paintCubes = (still: boolean) => {
      cctx.clearRect(0, 0, CW, CH);
      const w = Math.min(CW / 23, CH / 14.2), d = w * 0.9, cw = w * 0.94, ch = cw * 0.5;
      const cx = CW / 2, cy = CH * 0.5 + w * 1.25;
      if (w !== gW) { gW = w; gcw = cw; gch = ch; gcd = cw * 0.9; GR = buildGrads(cw, ch, gcd); }
      for (const fl of floaters) {
        const e = still ? 1 : Math.max(0, Math.min(1, (t - fl.delay) / 1.1));
        if (e <= 0) continue;
        const ez = 1 - Math.pow(1 - e, 3);
        const x = fl.fx * CW;
        const y0 = fl.fy * CH + (still ? 0 : Math.sin(t * fl.sp + fl.ph) * 8) - (1 - ez) * 36;
        if (!still) {
          let target = 0;
          if (cmx > -1e3) {
            const dd = Math.hypot(cmx - x, cmy - y0) / (w * 2.6);
            if (dd < 1) target = (1 - dd * dd) * w * 0.9;
          }
          fl.lift += (target - fl.lift) * (target > fl.lift ? 0.16 : 0.075);
          if (Math.abs(fl.lift) < 0.02) fl.lift = 0;
        }
        drawBox(x, y0 - fl.lift, fl.sc * (0.55 + 0.45 * ez), gcd, fl.acc, fl.lift > 0 ? 0.4 : 0, ez * fl.op);
      }
      for (const c of cubes) {
        const ring = Math.abs(c.i - 4) + Math.abs(c.j - 4);
        const delay = 0.2 + ring * 0.06 + c.k * 0.14 + c.fl * 0.5;
        const e = still ? 1 : Math.max(0, Math.min(1, (t - delay) / 0.9));
        if (e <= 0) continue;
        const ez = 1 - Math.pow(1 - e, 3);
        const bob = still ? 0 : c.fl ? Math.sin(t * 0.7 + c.ph) * 6 : c.pl ? Math.sin(t * 0.8 + c.ph) * 3 : Math.sin(t * 0.9 + (c.i + c.j) * 0.5) * 1.3;
        const x = cx + (c.i - c.j) * w;
        const y0 = cy + (c.i + c.j - 8) * w * 0.5 - c.k * d + bob - (1 - ez) * 44;
        if (!still) {
          let target = 0;
          if (cmx > -1e3) {
            const dd = Math.hypot(cmx - x, cmy - y0) / (w * 2.6);
            if (dd < 1) target = (1 - dd * dd) * w * 0.9;
          }
          c.lift += (target - c.lift) * (target > c.lift ? 0.16 : 0.075);
          if (Math.abs(c.lift) < 0.02) c.lift = 0;
        }
        const hot = Math.max(0, Math.min(1, c.lift / (w * 0.7)));
        const y = y0 - c.lift;
        const cd = gcd * c.h;
        if (hot > 0.08) {
          cctx.globalAlpha = 0.16 * hot;
          cctx.fillStyle = "rgba(18,25,140,0.5)";
          cctx.beginPath();
          cctx.ellipse(x, y0 + cd + ch, cw * 1.15, ch * 0.75, 0, 0, 6.2832);
          cctx.fill();
          cctx.globalAlpha = 1;
        }
        drawBox(x, y, 0.55 + 0.45 * ez, cd, c.acc, hot, ez * (c.fl ? 0.85 : c.pl ? 0.72 : 0.92));
      }
      if (!still) {
        cctx.save();
        cctx.globalCompositeOperation = "lighter";
        for (let s = 0; s < 8; s++) {
          const a = Math.max(0, Math.sin(t * 2.2 + s * 1.9)) * 0.5;
          if (a > 0.02) {
            const xs = cx + (s - 3.5) * w * 0.46 + Math.sin(s * 7.3) * w * 0.2;
            const y1 = cy - w * 0.6 - Math.abs(s - 3.5) * w * 0.15, y0 = y1 - w * 2.8;
            const lg = cctx.createLinearGradient(xs, y0, xs, y1);
            lg.addColorStop(0, "rgba(19,56,190,0)");
            lg.addColorStop(0.5, `rgba(60,70,255,${a.toFixed(3)})`);
            lg.addColorStop(1, "rgba(19,56,190,0)");
            cctx.strokeStyle = lg;
            cctx.lineWidth = 1.6;
            cctx.beginPath();
            cctx.moveTo(xs, y0);
            cctx.lineTo(xs, y1);
            cctx.stroke();
          }
        }
        cctx.restore();
        for (let m = 0; m < 7; m++) {
          const cyc = (t * (0.55 + m * 0.11) + m * 1.7) % 2.6;
          if (cyc > 1.6) continue;
          const u = cyc / 1.6;
          cctx.globalAlpha = Math.sin(u * Math.PI) * 0.9;
          cctx.fillStyle = "#4750ee";
          cctx.shadowColor = "rgba(19,56,190,0.9)";
          cctx.shadowBlur = 9;
          cctx.beginPath();
          cctx.arc(cx + Math.sin(m * 12.9898) * w * 2.2, cy - w * 0.4 - u * w * 4.6, 2, 0, 6.2832);
          cctx.fill();
          cctx.shadowBlur = 0;
        }
      }
      cctx.globalAlpha = 1;
    };

    let trailDirty = false;

    const paintTrail = (dt: number) => {
      const inHero0 = mx > -1e3;
      let trailLit = 0;
      if (!inHero0 && trailLit === 0) {
        if (trailDirty) { tctx.clearRect(0, 0, W, H); trailDirty = false; }
        return;
      }
      trailDirty = true;
      tctx.clearRect(0, 0, W, H);
      tctx.lineCap = "round";
      tctx.lineJoin = "round";
      const inHero = mx > -1e3;
      const f = Math.min(1, dt / 16.7);
      if (inHero) {
        if (vmx < -1e3) { vmx = mx; vmy = my; }
        // Virtual cursor the trail chases — tightened from the source's 0.1 so the
        // reveal/repel tracks the real pointer closely instead of visibly trailing it.
        vmx += (mx - vmx) * 0.28 * f;
        vmy += (my - vmy) * 0.28 * f;
      }
      const idleWant = inHero && idleT > 160 ? 1 : 0;
      ripple += (idleWant - ripple) * 0.055 * f;
      const CULL = (RING + BAND + 70) * (RING + BAND + 70);
      for (const p of trail) {
        const ddx = p.hx - vmx, ddy = p.hy - vmy;
        const d2 = inHero ? ddx * ddx + ddy * ddy : 1e12;
        if (p.vis <= 0.006 && d2 > CULL) { p.vis = 0; continue; }
        trailLit++;
        p.t += p.sp;
        const d = Math.sqrt(d2);
        const wv = Math.sin(t * 2.1 - d * 0.055);
        const edge = RING + ripple * wv * 40;
        const want = Math.max(0, Math.min(1, (edge - d) / BAND));
        p.vis += (want - p.vis) * (want > p.vis ? 0.12 : 0.05) * f;
        if (p.vis <= 0.006) { p.vis = 0; continue; }
        const e = p.vis * p.vis * (3 - 2 * p.vis);
        const k = (0.32 + e * 0.7) * p.size * (0.9 + Math.sin(p.t * p.pulse) * 0.06 + ripple * wv * 0.16);
        let px = 0, py = 0;
        const REACH = CLEAR * 2.4;
        if (inHero && d < REACH) {
          const q = 1 - d / REACH;
          const g = q * q * (3 - 2 * q);
          const nx = (p.hx - vmx) / (d || 1), ny = (p.hy - vmy) / (d || 1);
          const amt = g * CLEAR * 1.15 * p.push;
          const sw = g * 0.5 * p.swirl;
          px = (nx - ny * sw) * amt + dvx * g * 0.9;
          py = (ny + nx * sw) * amt + dvy * g * 0.9;
        }
        const ease = (Math.hypot(px - p.ox, py - p.oy) > 2 ? 0.22 : 0.08) * p.lag;
        p.ox += (px - p.ox) * ease * f;
        p.oy += (py - p.oy) * ease * f;
        let wx = Math.sin(t * 0.35 + p.ph) * 3.2, wy = Math.cos(t * 0.3 + p.ph) * 2.6;
        if (ripple > 0.01 && d < 1e4) {
          const nx = (p.hx - vmx) / (d || 1), ny = (p.hy - vmy) / (d || 1);
          const amp = ripple * 26 * (0.55 + p.push * 0.6);
          wx += nx * wv * amp; wy += ny * wv * amp;
          const sw = Math.cos(t * 1.7 - d * 0.045) * ripple * 9 * p.swirl;
          wx += -ny * sw; wy += nx * sw;
        }
        const x = p.hx + p.ox + wx;
        const y = p.hy + p.oy + wy;
        tctx.globalAlpha = Math.max(0.02, Math.min(0.92, e * (0.85 + ripple * wv * 0.22)));
        tctx.strokeStyle = p.col;
        tctx.save();
        tctx.translate(x, y);
        tctx.rotate(p.rot0 + Math.sin(t * 0.2 + p.ph) * 0.05);
        tctx.scale(k, k);
        tctx.lineWidth = 1.7 / k;
        ICONS[p.ic](tctx);
        tctx.restore();
      }
      tctx.globalAlpha = 1;
    };

    const size = () => {
      const r = hero.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = Math.max(1, Math.round(r.width));
      H = Math.max(1, Math.round(r.height));
      trailCv.width = Math.round(W * dpr);
      trailCv.height = Math.round(H * dpr);
      tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      csize();
      seedIcons();
    };
    size();

    // Drop all pointer-driven state. `forget` additionally discards the remembered
    // viewport position — used when the cursor leaves the document entirely, where
    // scrolling the hero back under it must NOT re-light the trail, because we no longer
    // know where the cursor is.
    const clearPointer = (forget: boolean) => {
      active = false;
      mx = -1e4; my = -1e4; cmx = -1e4; cmy = -1e4; vmx = -1e4; vmy = -1e4;
      if (forget) { lastCX = -1e4; lastCY = -1e4; }
    };

    // Re-derive the hero-relative pointer coords from the remembered viewport position.
    // `track` distinguishes the two callers: a real mousemove (true — also feeds cursor
    // velocity and resets the idle timer that drives the ripple) from a scroll (false —
    // the pointer itself has NOT moved, only its position relative to the hero, so it
    // must not register as activity).
    //
    // Whether the pointer counts as "in the hero" is decided by testing the live hero
    // rect, not by mouseenter/mouseleave: scrolling drags the hero across a stationary
    // cursor without firing either event, which is the whole bug this fixes.
    const applyPointer = (track: boolean) => {
      if (lastCX < -1e3) return;
      const r = hero.getBoundingClientRect();
      const inside =
        lastCX >= r.left && lastCX <= r.right && lastCY >= r.top && lastCY <= r.bottom;
      if (!inside) { clearPointer(false); return; }
      const cr = cubeCv.getBoundingClientRect();
      cmx = lastCX - cr.left;
      cmy = lastCY - cr.top;
      const nx = lastCX - r.left, ny = lastCY - r.top;
      if (track && mx > -1e3) { dvx = nx - mx; dvy = ny - my; }
      mx = nx; my = ny;
      if (track) { idleT = 0; active = true; }
    };

    const onMove = (e: MouseEvent) => {
      lastCX = e.clientX; lastCY = e.clientY;
      applyPointer(true);
    };
    const onScroll = () => {
      lastScrollAt = performance.now();
      applyPointer(false);
    };
    const onDocLeave = () => clearPointer(true);
    // Bound to the window rather than the hero element: the hero can scroll out from
    // under a stationary pointer, so containment is resolved in applyPointer instead.
    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("mouseleave", onDocLeave, { passive: true });
    let resizeT: ReturnType<typeof setTimeout>;
    const onResize = () => { clearTimeout(resizeT); resizeT = setTimeout(size, 180); };
    window.addEventListener("resize", onResize);

    const tick = (now: number) => {
      const dt = Math.min(48, now - lastTime);
      lastTime = now;
      t += dt / 1000;
      dvx *= 0.86; dvy *= 0.86;
      if (active) idleT += dt;
      paintTrail(dt);
      // The cube monument is not a cursor effect — it has continuous ambient motion of
      // its own (per-cube bob, the eight energy beams, the rising spark dots), so it must
      // keep being redrawn rather than held on one frame. This used to be gated on a
      // `cubesBusy` flag that went false once the entrance settled and nothing was
      // lifted, which froze the monument the moment the cursor left the hero and made the
      // whole section look dead. It now repaints continuously, but rate-limited — see
      // CUBE_FRAME_MS / SCROLL_QUIET_MS above for why. prefers-reduced-motion still paints
      // exactly one static frame.
      //
      // ⚠️ Do not rely on the IntersectionObserver below as the perf guard: the hero is
      // taller (~832px) than this page's entire scroll range (~779px), so it is never
      // fully out of view and that observer effectively never fires here. The rate limits
      // are what actually keep this off the scroll critical path.
      cubeAccum += dt;
      const scrolling = now - lastScrollAt < SCROLL_QUIET_MS;
      const pointerInHero = mx > -1e3;
      if (cubeAccum >= CUBE_FRAME_MS && !(scrolling && !pointerInHero)) {
        cubeAccum = 0;
        paintCubes(false);
      }
      raf = requestAnimationFrame(tick);
    };

    let io: IntersectionObserver | null = null;
    if (reduced) {
      paintCubes(true);
    } else if (playing) {
      // `t` starts at 0 above, fresh for this effect run — since this run only
      // happens once `playing` flips true (see the dep array below), the cube
      // entrance animation plays out for real, in front of the user, instead of
      // running its course invisibly while the full-page loader still covers it.
      raf = requestAnimationFrame(tick);
      if (window.IntersectionObserver) {
        io = new IntersectionObserver(
          (entries) => {
            const vis = entries.some((e) => e.isIntersecting);
            if (!vis && raf) { cancelAnimationFrame(raf); raf = null; }
            else if (vis && !raf) { lastTime = performance.now(); raf = requestAnimationFrame(tick); }
          },
          { threshold: 0 },
        );
        io.observe(hero);
      }
    }

    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (io) io.disconnect();
      clearTimeout(resizeT);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("mouseleave", onDocLeave);
    };
  }, [heroRef, playing]);

  return { cubeCanvasRef, trailCanvasRef };
}
