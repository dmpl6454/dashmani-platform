"use client";
import { useState, useEffect, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useHrAuth } from "@/lib/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/v1";

/* ── helpers ── */
const emailOk = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const phoneOk = (v: string) => !v || /^\+?[\d\s\-]{7,16}$/.test(v);
const pwScore = (v: string) => {
  let s = 0;
  if (v.length >= 8) s++;
  if (v.length >= 12) s++;
  if (/[A-Z]/.test(v) && /[a-z]/.test(v)) s++;
  if (/\d/.test(v) && /[^A-Za-z0-9]/.test(v)) s++;
  return s;
};
const pwLabel = ["", "Weak", "Fair", "Good", "Strong"];
const greet = (h: number) => {
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  if (h < 21) return "Good evening";
  return "Wrapping up";
};
const fmtTime = (d: Date) =>
  d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
const fmtDate = (d: Date) =>
  d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });

/* ── icons ── */
const IcMail = (p: React.SVGProps<SVGSVGElement>) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>
);
const IcLock = (p: React.SVGProps<SVGSVGElement>) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
);
const IcUser = (p: React.SVGProps<SVGSVGElement>) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/></svg>
);
const IcPhone = (p: React.SVGProps<SVGSVGElement>) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.9 19.9 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6 19.9 19.9 0 0 1-3.1-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>
);
const IcEye = (p: React.SVGProps<SVGSVGElement>) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>
);
const IcEyeOff = (p: React.SVGProps<SVGSVGElement>) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M3 3l18 18"/><path d="M10.6 6.1A9 9 0 0 1 12 6c6.5 0 10 7 10 7a17 17 0 0 1-3.1 3.9"/><path d="M6.5 7.5C3.7 9.3 2 12 2 12s3.5 7 10 7c1.5 0 2.8-.3 4-.8"/><path d="M14 14a3 3 0 0 1-4-4"/></svg>
);
const IcCheck = (p: React.SVGProps<SVGSVGElement>) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="m5 12 4.5 4.5L19 7"/></svg>
);
const IcAlert = (p: React.SVGProps<SVGSVGElement>) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3v.1"/></svg>
);
const IcArrow = (p: React.SVGProps<SVGSVGElement>) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M5 12h14m-5-5 5 5-5 5"/></svg>
);
const IcClock = (p: React.SVGProps<SVGSVGElement>) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
);
const IcEdit = (p: React.SVGProps<SVGSVGElement>) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
);
const IcChart = (p: React.SVGProps<SVGSVGElement>) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg>
);
const IcTrophy = (p: React.SVGProps<SVGSVGElement>) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M7 4h10v4a5 5 0 0 1-10 0z"/><path d="M5 4H3v3a3 3 0 0 0 3 3M19 4h2v3a3 3 0 0 1-3 3"/><path d="M10 14h4M9 18h6M9 21h6M12 14v4"/></svg>
);
const IcBell = (p: React.SVGProps<SVGSVGElement>) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21a2 2 0 0 0 4 0"/></svg>
);
const IcSparkle = (p: React.SVGProps<SVGSVGElement>) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1M5.6 18.4l2.1-2.1m8.6-8.6 2.1-2.1"/></svg>
);

/* ── Logo mark ── */
const Mark = ({ size = 32 }: { size?: number }) => (
  <div
    className="rounded-xl bg-ink text-white grid place-items-center font-black tracking-widest flex-shrink-0"
    style={{ width: size, height: size, fontSize: size * 0.34 }}
  >
    DS
  </div>
);

/* ── useCapsLock ── */
function useCapsLock() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (typeof e.getModifierState === "function") setOn(e.getModifierState("CapsLock"));
    };
    window.addEventListener("keydown", h);
    window.addEventListener("keyup", h);
    return () => { window.removeEventListener("keydown", h); window.removeEventListener("keyup", h); };
  }, []);
  return on;
}

/* ── Floating-label field ── */
interface FieldProps {
  id: string;
  label: string;
  type?: string;
  Icon: React.FC<React.SVGProps<SVGSVGElement>>;
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
  success?: boolean;
  hint?: string;
  autoComplete?: string;
  onBlur?: () => void;
  optional?: boolean;
}

function Field({ id, label, type = "text", Icon, value, onChange, error, success, hint, autoComplete, onBlur, optional }: FieldProps) {
  const [focused, setFocused] = useState(false);
  const [show, setShow] = useState(false);
  const isPw = type === "password";
  const realType = isPw ? (show ? "text" : "password") : type;
  const filled = value.length > 0;
  const capsOn = useCapsLock();
  const showCaps = isPw && focused && capsOn;

  return (
    <div className={`auth-field-wrap${error ? " error" : ""}${focused ? " is-focused" : ""}${filled ? " is-filled" : ""}`}>
      <span className="auth-field-icon"><Icon /></span>
      <input
        id={id}
        type={realType}
        value={value}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); onBlur?.(); }}
        className={`auth-field${error ? " error" : ""}${success ? " success" : ""}`}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-err` : hint ? `${id}-hint` : undefined}
      />
      <label htmlFor={id} className="auth-field-label">
        {label}{optional && <span className="ml-1 normal-case tracking-normal text-[#9C947C] font-medium"> (optional)</span>}
      </label>
      {isPw && (
        <button
          type="button"
          aria-label={show ? "Hide password" : "Show password"}
          onClick={() => setShow((s) => !s)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9C947C] hover:text-[#1A1A1A] p-1 rounded-md transition-colors"
        >
          {show ? <IcEye /> : <IcEyeOff />}
        </button>
      )}
      {success && !isPw && (
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[#4A7C52]">
          <IcCheck />
        </span>
      )}
      {showCaps && (
        <span className="absolute -top-2.5 right-12 text-[9.5px] uppercase tracking-[0.14em] font-black bg-[#C05826] text-white px-1.5 py-0.5 rounded-full flex items-center gap-1" style={{ boxShadow: "2px 2px 0 #1A1A1A" }}>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M12 3 3 13h5v8h8v-8h5z" strokeLinejoin="round" strokeLinecap="round"/></svg>
          Caps
        </span>
      )}
      {error && (
        <p id={`${id}-err`} role="alert" className="mt-1.5 ml-1 text-[12px] text-[#B83728] font-semibold flex items-center gap-1.5">
          <IcAlert /> {error}
        </p>
      )}
      {!error && hint && (
        <p id={`${id}-hint`} className="mt-1.5 ml-1 text-[11.5px] text-[#9C947C] font-medium">{hint}</p>
      )}
    </div>
  );
}

/* ── Typewriter daily report card ── */
const REPORT_LINES = [
  { kind: "head", text: "Daily Update · 18 May" },
  { kind: "done", text: "Shipped IG carousel for @meher.co" },
  { kind: "done", text: "Closed 3 review threads on Otto" },
  { kind: "done", text: "Logged 6h focus · 0 context-switches" },
  { kind: "todo", text: "Tomorrow: Caravan reels v3 review" },
];

function useTypewriter(lines: typeof REPORT_LINES, charsPerSec = 42) {
  const [out, setOut] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const stateRef = useRef({ buf: [""], li: 0 });

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setOut(lines.map((l) => l.text)); setDone(true); return; }
    stateRef.current = { buf: [""], li: 0 };
    let raf: number;
    let last = performance.now();
    const tick = (t: number) => {
      const dt = (t - last) / 1000;
      const advance = Math.floor(dt * charsPerSec);
      if (advance > 0) {
        last = t;
        const s = stateRef.current;
        for (let k = 0; k < advance; k++) {
          if (s.li >= lines.length) break;
          if (s.buf[s.li] == null) s.buf[s.li] = "";
          if (s.buf[s.li].length < lines[s.li].text.length) {
            s.buf[s.li] = lines[s.li].text.slice(0, s.buf[s.li].length + 1);
          } else {
            s.li++;
            if (s.li < lines.length) s.buf[s.li] = "";
            last = t + 110;
            break;
          }
        }
        setOut([...s.buf]);
        if (s.li >= lines.length) { setDone(true); return; }
      }
      raf = requestAnimationFrame(tick);
    };
    const startT = setTimeout(() => { raf = requestAnimationFrame(tick); }, 900);
    return () => { cancelAnimationFrame(raf); clearTimeout(startT); };
  }, []);

  return { out, done };
}

function ReportCard() {
  const { out, done } = useTypewriter(REPORT_LINES, 60);
  const cursorLineIdx = useMemo(() => {
    if (done) return -1;
    for (let i = 0; i < REPORT_LINES.length; i++) {
      if (out[i] && out[i].length < REPORT_LINES[i].text.length) return i;
    }
    return REPORT_LINES.length - 1;
  }, [out, done]);

  return (
    <div className="v3-card w-[340px] overflow-hidden">
      <div className="px-5 h-12 flex items-center justify-between" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
        <div className="flex items-center gap-2">
          <IcEdit className="text-[#5D5FEF]" />
          <span className="text-[13px] font-bold text-[#1A1A1A]">Submit your daily update</span>
        </div>
        <span className="text-[10.5px] font-bold text-[#E8C83A] bg-[#FFF3C4] px-2 py-0.5 rounded-full">DRAFT</span>
      </div>
      <div className="px-5 py-4 font-mono text-[12.5px] leading-[1.85] text-[#3A3A3A] min-h-[160px]">
        {REPORT_LINES.map((l, i) => {
          const txt = out[i] || "";
          const isCursor = i === cursorLineIdx;
          if (l.kind === "head") return (
            <div key={i} className="text-[#1A1A1A] font-bold mb-1">{txt}{isCursor && <span className="inline-block w-[2px] h-[1em] bg-[#1A1A1A] align-[-2px] ml-px" style={{ animation: "auth-blink .9s steps(1) infinite" }}/>}</div>
          );
          if (l.kind === "done") return (
            <div key={i} className="flex items-start gap-2">
              <span className={`text-[#4A7C52] font-bold mt-0.5 ${txt ? "" : "opacity-30"}`}>✓</span>
              <span>{txt}{isCursor && <span className="inline-block w-[2px] h-[1em] bg-[#1A1A1A] align-[-2px] ml-px" style={{ animation: "auth-blink .9s steps(1) infinite" }}/>}</span>
            </div>
          );
          return (
            <div key={i} className="flex items-start gap-2">
              <span className={`text-[#C05826] font-bold mt-0.5 ${txt ? "" : "opacity-30"}`}>○</span>
              <span>{txt}{isCursor && <span className="inline-block w-[2px] h-[1em] bg-[#1A1A1A] align-[-2px] ml-px" style={{ animation: "auth-blink .9s steps(1) infinite" }}/>}</span>
            </div>
          );
        })}
      </div>
      <div className="px-5 py-3 flex items-center justify-between" style={{ borderTop: "1.5px dashed rgba(26,26,26,0.12)" }}>
        <span className="text-[11px] text-[#6C6555] font-semibold flex items-center gap-1.5"><IcClock /> 09:42 · India</span>
        <button className="bg-[#1A1A1A] text-white px-3 py-1.5 rounded-full text-[11.5px] font-semibold" style={{ boxShadow: "2px 2px 0 #1A1A1A" }}>Submit →</button>
      </div>
    </div>
  );
}

/* ── Attendance heatmap card ── */
const ATT_CLR: Record<string, string> = {
  P: "bg-[rgba(74,124,82,0.85)]",
  WFH: "bg-[rgba(93,95,239,0.65)]",
  WE: "bg-[#F3EED8] border border-[#EDE7D2]",
  A: "bg-[rgba(192,88,38,0.7)]",
};
const ATT_DATA = Array.from({ length: 30 }, (_, i) => {
  const day = (i + 1) % 7;
  if (day === 0 || day === 6) return { d: i + 1, s: "WE" };
  const seed = [0.1, 0.7, 0.2, 0.6, 0.15, 0.8, 0.3, 0.75, 0.12, 0.65, 0.18, 0.9, 0.25, 0.7, 0.1, 0.8, 0.22, 0.6, 0.15, 0.75, 0.12, 0.68, 0.2, 0.78, 0.14, 0.7, 0.19, 0.82, 0.16, 0.71][i];
  if (seed < 0.18) return { d: i + 1, s: "WFH" };
  if (seed < 0.20) return { d: i + 1, s: "A" };
  return { d: i + 1, s: "P" };
});

function AttendanceCard() {
  const [visible, setVisible] = useState(0);
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setVisible(ATT_DATA.length); return; }
    let i = 0;
    const id = setInterval(() => { i++; setVisible(i); if (i >= ATT_DATA.length) clearInterval(id); }, 55);
    return () => clearInterval(id);
  }, []);
  const rate = Math.round(ATT_DATA.filter((d) => d.s === "P" || d.s === "WFH").length / ATT_DATA.length * 100);
  return (
    <div className="v3-card w-[280px] p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-[10.5px] uppercase tracking-[0.16em] font-bold text-[#9C947C]">Attendance · May</p>
          <p className="font-num text-[22px] font-semibold text-[#1A1A1A] leading-none mt-1">{rate}%</p>
        </div>
        <span className="bg-[#EDF4EE] text-[#4A7C52] text-[10.5px] font-bold px-2 py-1 rounded-full">on track</span>
      </div>
      <div className="grid grid-cols-10 gap-1.5">
        {ATT_DATA.map((d, i) => (
          <div
            key={d.d}
            className={`rounded-[4px] w-full aspect-square ${i < visible ? (ATT_CLR[d.s] || "bg-[#F3EED8]") : "opacity-0"}`}
            style={{ animationDelay: `${i * 0.05}s` }}
            title={`${d.d}: ${d.s}`}
          />
        ))}
      </div>
      <div className="flex gap-3 mt-3 flex-wrap">
        {[{ l: "Present", c: "bg-[rgba(74,124,82,0.85)]" }, { l: "WFH", c: "bg-[rgba(93,95,239,0.65)]" }, { l: "Weekend", c: "bg-[#F3EED8] border border-[#EDE7D2]" }].map((x) => (
          <span key={x.l} className="flex items-center gap-1 text-[10px] text-[#6C6555] font-semibold">
            <span className={`h-2 w-2 rounded-sm ${x.c}`} />{x.l}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ── Growth sparklines card ── */
/* ── Ring tile ── */
function RingTile() {
  return (
    <div className="v3-card w-[170px] p-4 flex flex-col items-center text-center">
      <div className="relative w-[96px] h-[96px]">
        <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
          <circle cx="50" cy="50" r="42" stroke="#F3EED8" strokeWidth="9" fill="none" />
          <circle cx="50" cy="50" r="42" stroke="#5D5FEF" strokeWidth="9" fill="none" strokeLinecap="round"
            strokeDasharray="264" style={{ "--off": "74", animation: "auth-ringDraw 1.4s cubic-bezier(0.22,1,0.36,1) .6s both" } as React.CSSProperties} />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <p className="font-num text-[24px] font-semibold text-[#1A1A1A] leading-none">72%</p>
          <p className="text-[9.5px] font-bold uppercase tracking-wider text-[#6C6555] mt-0.5">May goal</p>
        </div>
      </div>
      <p className="text-[11px] text-[#6C6555] font-semibold mt-2 flex items-center gap-1">
        <IcTrophy className="text-[#E8C83A]" /> 3rd · 142 XP
      </p>
    </div>
  );
}

/* ── Notif ticker ── */
const NOTIFS_DATA = [
  { kind: "success", text: "Your leave was approved", sub: "May 19–20 · Casual leave" },
  { kind: "salary", text: "April salary slip available", sub: "₹72,600 net pay" },
  { kind: "review", text: "Q2 review scheduled", sub: "May 20 at 3pm" },
  { kind: "task", text: "New task: Design IG grid", sub: "Due May 18 · High" },
];
const NOTIF_BG: Record<string, string> = {
  success: "bg-[#EDF4EE]",
  salary: "bg-[#EEF4ED]",
  review: "bg-[#EDEDFD]",
  task: "bg-[#FFF3C4]",
};
const NOTIF_ICON: Record<string, React.ReactNode> = {
  success: <IcCheck className="text-[#4A7C52]" />,
  salary: <IcChart className="text-[#8BA888]" />,
  review: <IcSparkle className="text-[#5D5FEF]" />,
  task: <IcBell className="text-[#3A3A3A]" />,
};

function NotifTicker() {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % NOTIFS_DATA.length), 3000);
    return () => clearInterval(t);
  }, []);
  const n = NOTIFS_DATA[idx];
  return (
    <div key={idx} className="v3-card-sm w-[260px] p-3 px-4 flex items-center gap-3">
      <div className={`w-8 h-8 rounded-xl grid place-items-center shrink-0 ${NOTIF_BG[n.kind]}`}>{NOTIF_ICON[n.kind]}</div>
      <div className="flex-1 min-w-0" style={{ animation: "auth-fadeUp .42s cubic-bezier(0.34,1.45,0.64,1) both" }}>
        <p className="text-[12px] font-bold text-[#1A1A1A] leading-tight truncate">{n.text}</p>
        <p className="text-[10.5px] text-[#6C6555] font-medium mt-0.5 truncate">{n.sub}</p>
      </div>
      <span className="h-2 w-2 rounded-full bg-[#C05826] shrink-0" style={{ animation: "pulseDot 1.8s ease-in-out infinite" }} />
    </div>
  );
}

/* ── Submit banner ── */
function SubmitBanner() {
  return (
    <div className="w-[300px] p-5 flex items-center gap-3 relative overflow-hidden rounded-[20px]"
      style={{ background: "#1A1A1A", border: "2px solid #1A1A1A", boxShadow: "4px 4px 0 rgba(245,213,71,.55)" }}>
      <div className="absolute top-[-40px] right-[-40px] w-[180px] h-[180px] rounded-full" style={{ background: "rgba(245,213,71,.20)", filter: "blur(50px)" }} />
      <div className="relative flex-1">
        <p className="text-[#F5D547] text-[10.5px] font-black uppercase tracking-[0.16em] mb-1">Action required</p>
        <p className="text-white text-[15px] font-bold leading-tight">Submit your daily update</p>
        <p className="text-white/55 text-[11.5px] mt-1 font-medium">Don't forget to log today's work</p>
      </div>
      <div className="relative h-10 w-10 rounded-xl bg-[#F5D547] grid place-items-center shrink-0" style={{ boxShadow: "0 0 0 1px rgba(26,26,26,.18)" }}>
        <IcArrow className="text-[#1A1A1A]" />
      </div>
    </div>
  );
}

/* ── Right stage with parallax ── */
function RightStage() {
  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    let raf: number;
    let tx = 0, ty = 0, ctx = 0, cty = 0;
    const onMove = (e: MouseEvent) => {
      const r = stage.getBoundingClientRect();
      tx = (e.clientX - r.left) / r.width - 0.5;
      ty = (e.clientY - r.top) / r.height - 0.5;
    };
    const onLeave = () => { tx = 0; ty = 0; };
    const tick = () => {
      ctx += (tx - ctx) * 0.08;
      cty += (ty - cty) * 0.08;
      stage.querySelectorAll<HTMLElement>("[data-px]").forEach((el) => {
        const depth = parseFloat(el.getAttribute("data-px") || "1");
        el.style.setProperty("--mx", `${ctx * depth * 18}px`);
        el.style.setProperty("--my", `${cty * depth * 14}px`);
      });
      raf = requestAnimationFrame(tick);
    };
    stage.addEventListener("mousemove", onMove);
    stage.addEventListener("mouseleave", onLeave);
    raf = requestAnimationFrame(tick);
    return () => {
      stage.removeEventListener("mousemove", onMove);
      stage.removeEventListener("mouseleave", onLeave);
      cancelAnimationFrame(raf);
    };
  }, []);

  const card = (depth: number, style: React.CSSProperties, children: React.ReactNode, animDelay = "0s", animDur = "11s") => (
    <div
      className="absolute"
      data-px={depth}
      style={{
        ...style,
        transform: "translate3d(var(--mx,0), var(--my,0), 0)",
        animation: `auth-drift ${animDur} ease-in-out ${animDelay} infinite`,
      }}
    >
      {children}
    </div>
  );

  return (
    <div ref={stageRef} className="relative w-full h-full">
      <div className="absolute inset-0 rounded-[28px] opacity-60 pointer-events-none"
        style={{ backgroundImage: "radial-gradient(rgba(93,95,239,.18) 1px,transparent 1px)", backgroundSize: "22px 22px" }} />
      <div className="absolute rounded-full pointer-events-none" style={{ top: "-60px", right: "-30px", width: "320px", height: "320px", background: "radial-gradient(circle, rgba(245,213,71,.42), transparent 65%)", filter: "blur(40px)", animation: "auth-orbDrift 14s ease-in-out infinite" }} />
      <div className="absolute rounded-full pointer-events-none" style={{ bottom: "-20px", left: "-40px", width: "340px", height: "340px", background: "radial-gradient(circle, rgba(93,95,239,.26), transparent 65%)", filter: "blur(40px)", animation: "auth-orbDrift 14s ease-in-out -5s infinite" }} />
      <div className="absolute rounded-full pointer-events-none" style={{ top: "40%", right: "30%", width: "200px", height: "200px", background: "radial-gradient(circle, rgba(224,122,95,.18), transparent 65%)", filter: "blur(40px)", animation: "auth-orbDrift 14s ease-in-out -9s infinite" }} />

      {card(0.7, { top: "8%", left: "8%" }, <ReportCard />, ".4s", "11s")}
      {card(1.4, { top: "4%", right: "2%" }, <AttendanceCard />, "1.2s", "13s")}
      {card(1.7, { top: "62%", left: "4%" }, <RingTile />, ".7s", "10s")}
      {card(0.5, { bottom: "2%", left: "22%" }, <SubmitBanner />, "1.8s", "12s")}
      {card(2.0, { top: "38%", left: "18%" }, <NotifTicker />, ".4s", "9s")}
    </div>
  );
}

/* ── Day timeline ── */
const DAY_STEPS = [
  { h: 9,  m: 30, title: "Daily update",  body: "A short morning ritual — what shipped yesterday, what's on today, blockers if any.", accent: "action" },
  { h: 11, m: 0,  title: "Focus block",   body: "Heads-down work. We respect your calendar — no pings during marked focus time.",      accent: "sage" },
  { h: 12, m: 0,  title: "Team standup",  body: "A 15-min jam to unblock each other. Skip if you're heads-down — we keep notes.",      accent: "terra" },
  { h: 15, m: 0,  title: "Client review", body: "Open the review room. Read comments, action what's needed, close the loop calmly.",   accent: "indigo" },
  { h: 17, m: 30, title: "Clock out",     body: "Stop the timer. Your week-view fills in automatically — no extra forms.",             accent: "success" },
];
const ACCENT_BG: Record<string, string> = { action: "bg-[#FFF3C4]", sage: "bg-[#EEF4ED]", terra: "bg-[#FDF0EC]", indigo: "bg-[#EDEDFD]", success: "bg-[#EDF4EE]" };
const ACCENT_TX: Record<string, string> = { action: "text-[#3A3A3A]", sage: "text-[#8BA888]", terra: "text-[#E07A5F]", indigo: "text-[#5D5FEF]", success: "text-[#4A7C52]" };

function DayTimeline({ now }: { now: Date }) {
  const [active, setActive] = useState<number | null>(null);
  const [inView, setInView] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!wrapRef.current) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setInView(true); return; }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => setInView(e.isIntersecting));
    }, { threshold: 0.2 });
    io.observe(wrapRef.current);
    return () => io.disconnect();
  }, []);

  // Scroll-linked horizontal reveal: on phones the rail is wider than the
  // viewport. We map the page's vertical scroll progress to the rail's
  // horizontal scroll — so scrolling DOWN pans the timeline from the first card
  // through to the last. Anchored to the cards row itself: progress holds at 0
  // (first card) until the cards settle into the upper-middle of the viewport,
  // then pans to the last card over the next ~half viewport of scrolling, with
  // the cards fully visible the whole way. On lg+ the rail fits, so maxScroll is
  // 0 and this no-ops entirely.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const wrap = wrapRef.current;
    if (!scroller || !wrap) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const maxScroll = scroller.scrollWidth - scroller.clientWidth;
      if (maxScroll <= 1) return; // desktop / no overflow — leave it alone
      const rect = scroller.getBoundingClientRect();
      const vh = window.innerHeight || 1;
      const start = vh * 0.5, end = vh * 0.05;
      const progress = Math.min(1, Math.max(0, (start - rect.top) / (start - end)));
      scroller.scrollLeft = progress * maxScroll;
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);


  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const dayStart = 9 * 60, dayEnd = 18 * 60;
  const nowIdx = (() => {
    for (let i = DAY_STEPS.length - 1; i >= 0; i--) {
      if (minutesNow >= DAY_STEPS[i].h * 60 + DAY_STEPS[i].m) return i;
    }
    return -1;
  })();
  const nowPct = ((Math.max(dayStart, Math.min(dayEnd, minutesNow)) - dayStart) / (dayEnd - dayStart)) * 100;
  const offHours = minutesNow < dayStart || minutesNow > dayEnd;

  return (
    <div ref={wrapRef} className={`mt-12 ${inView ? "tl-anim" : ""}`}>
      {/* On phones the 5-step rail can't fit side-by-side without crushing each
          card (text overflowed). Let it scroll horizontally on small screens while
          keeping the full inline layout from lg up. */}
      <div ref={scrollerRef} className="-mx-6 px-6 overflow-x-auto pb-3 lg:mx-0 lg:px-0 lg:pb-0 lg:overflow-visible [scrollbar-width:none] [-ms-overflow-style:none]">
        <div className="tl-rail relative px-2 min-w-[820px] lg:min-w-0">
          {!offHours && (
            <div className="absolute z-10 pointer-events-none" style={{ left: `calc(${nowPct}% - 1px)`, top: 0, bottom: 0 }}>
              <div className="absolute top-[18px] -translate-x-1/2 w-[2.5px] h-7 bg-[#5D5FEF] rounded-full" style={{ boxShadow: "0 0 0 4px rgba(93,95,239,.15)" }} />
              <div className="absolute top-[-26px] -translate-x-1/2 bg-[#1A1A1A] text-white text-[10px] font-black uppercase tracking-[0.14em] px-2 py-1 rounded-full font-mono whitespace-nowrap">NOW · {fmtTime(now)}</div>
            </div>
          )}
          <div className="grid grid-cols-5 gap-3">
            {DAY_STEPS.map((s, i) => {
            const isPast = i < nowIdx;
            const isNow = i === nowIdx;
            return (
              <div
                key={s.title}
                className={`tl-step${active === i ? " active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onMouseLeave={() => setActive(null)}
                style={{ "--d": `${i * 0.09}s` } as React.CSSProperties}
              >
                <div className="flex items-center justify-center mb-3">
                  <div className={`tl-node${isPast ? " done" : ""}${isNow ? " now" : ""}`} />
                </div>
                <div className="tl-card v3-card p-4 transition-all">
                  {/* Time pill + status grouped on the left with a gap — using
                      justify-between pushed the DONE/UPCOMING label onto the card
                      edge where it looked clipped on narrow phones. */}
                  <div className="flex items-center gap-2 mb-3">
                    <div className={`px-2 py-0.5 rounded-md font-mono text-[10px] uppercase tracking-wider font-bold shrink-0 ${ACCENT_BG[s.accent]} ${ACCENT_TX[s.accent]}`} style={{ border: "1px solid rgba(26,26,26,.10)" }}>
                      {String(s.h).padStart(2, "0")}:{String(s.m).padStart(2, "0")}
                    </div>
                    {isPast && <span className="text-[9px] font-bold uppercase tracking-wider text-[#4A7C52] inline-flex items-center gap-1 shrink-0 whitespace-nowrap"><IcCheck />Done</span>}
                    {isNow && <span className="text-[9px] font-bold uppercase tracking-wider text-[#5D5FEF] shrink-0 whitespace-nowrap">Live</span>}
                    {i > nowIdx && <span className="text-[9px] font-bold uppercase tracking-wider text-[#9C947C] shrink-0 whitespace-nowrap">Upcoming</span>}
                  </div>
                  <h3 className="font-display text-[15px] font-semibold text-[#1A1A1A] leading-snug min-h-[2.6em]">{s.title}</h3>
                  <p className="text-[12px] text-[#6C6555] mt-2 leading-relaxed font-medium">{s.body}</p>
                </div>
              </div>
            );
          })}
          </div>
        </div>
      </div>
      <div className="v3-card-sm mt-6 p-4 px-5 flex items-center gap-4 flex-wrap justify-between">
        <div className="flex items-center gap-3">
          <div className="px-2 py-0.5 rounded-md font-mono text-[10px] uppercase tracking-wider font-bold bg-[#F3EED8] text-[#3A3A3A]" style={{ border: "1px solid rgba(26,26,26,.10)" }}>anytime</div>
          <div>
            <p className="font-display text-[16px] font-semibold text-[#1A1A1A] leading-tight">Leave · claims · reports</p>
            <p className="text-[12px] text-[#6C6555] font-medium">Apply, log, learn — all in one quiet menu, no extra meetings.</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {[{ l: "Leave", c: "bg-[#FDF0EC]" }, { l: "Claims", c: "bg-[#FFF3C4]" }, { l: "Reports", c: "bg-[#EDEDFD]" }, { l: "Handbook", c: "bg-[#EEF4ED]" }].map((c) => (
            <span key={c.l} className={`px-2.5 py-1 rounded-full text-[10.5px] font-bold text-[#3A3A3A] ${c.c}`} style={{ border: "1px solid rgba(26,26,26,.10)" }}>{c.l}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── Count-up stat ── */
function CountUp({ value, decimals = 0 }: { value: number; decimals?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        io.unobserve(el);
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (reduce) { el.textContent = Number(value).toFixed(decimals); return; }
        const start = performance.now();
        const tick = (now: number) => {
          const k = Math.min(1, (now - start) / 1100);
          const eased = 1 - Math.pow(1 - k, 3);
          el.textContent = decimals ? (value * eased).toFixed(decimals) : Math.round(value * eased).toString();
          if (k < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    }, { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, [value, decimals]);
  return <span ref={ref}>{decimals ? (0).toFixed(decimals) : "0"}</span>;
}

/* ── Forgot password modal ── */
function ForgotPasswordModal({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, app: "hr" }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error?.message || "Something went wrong");
      setSent(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="v3-card p-7 w-full max-w-sm relative" onClick={(e) => e.stopPropagation()} style={{ animation: "auth-popIn .42s cubic-bezier(0.34,1.45,0.64,1) both" }}>
        <button type="button" onClick={onClose} aria-label="Close" className="absolute top-4 right-4 text-[#9C947C] hover:text-[#1A1A1A] text-xl leading-none transition-colors">×</button>
        <h2 className="font-display text-[22px] text-[#1A1A1A] font-semibold mb-1">Forgot password?</h2>
        {sent ? (
          <p className="text-sm text-[#6C6555] mt-3">If that email is registered, a reset link has been sent. Check your inbox — and your spam folder if you don't see it within a minute. The link is valid for 24 hours.</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4 mt-3">
            <p className="text-sm text-[#9C947C]">Enter your account email and we'll send a reset link.</p>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="you@digitalsukoon.com"
              className="w-full px-4 py-3 border-[1.5px] border-[#D4CBBA] rounded-[14px] text-sm text-[#1A1A1A] bg-[#FDFCF0] placeholder:text-[#9C947C] focus:outline-none focus:border-[#5D5FEF] transition-all"
              style={{ boxShadow: "0 0 0 0 transparent" }}
              onFocus={(e) => { e.currentTarget.style.boxShadow = "0 0 0 3px rgba(93,95,239,0.28)"; }}
              onBlur={(e) => { e.currentTarget.style.boxShadow = "0 0 0 0 transparent"; }}
            />
            {error && <p className="text-xs text-[#B83728] font-semibold flex items-center gap-1"><IcAlert /> {error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="btn-3d w-full py-3 rounded-full bg-[#1A1A1A] text-white text-sm font-bold disabled:opacity-50 transition-all"
            >
              {loading ? "Sending…" : "Send reset link"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

/* ── Main page ── */
export default function LoginPage() {
  const router = useRouter();
  const { login } = useHrAuth();

  const [tab, setTab] = useState<"signin" | "signup">("signin");
  const [identifier, setIdentifier] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [pwBlurred, setPwBlurred] = useState(false);
  const [emailBlurred, setEmailBlurred] = useState(false);
  const [submitState, setSubmitState] = useState<"idle" | "loading" | "success">("idle");
  const [errs, setErrs] = useState<Record<string, string | null>>({});
  const [successMsg, setSuccessMsg] = useState("");
  const [forgotOpen, setForgotOpen] = useState(false);
  const [liveT, setLiveT] = useState<Date | null>(null);
  const [confetti, setConfetti] = useState<{ id: number; c: string; cx: number; cy: number; cr: number; d: number }[]>([]);

  const segRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLiveT(new Date());
    const id = setInterval(() => setLiveT(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  /* scroll progress */
  useEffect(() => {
    const el = document.getElementById("auth-scroll-prog");
    if (!el) return;
    const onScroll = () => {
      const h = document.documentElement;
      const max = h.scrollHeight - h.clientHeight;
      const p = max > 0 ? (h.scrollTop / max) * 100 : 0;
      el.style.setProperty("--p", `${p}%`);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  /* reveal observer */
  useEffect(() => {
    const els = document.querySelectorAll<HTMLElement>(".auth-reveal");
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { (e.target as HTMLElement).classList.add("in"); io.unobserve(e.target); } });
    }, { threshold: 0.15 });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  /* segmented pill */
  useEffect(() => {
    if (!segRef.current) return;
    const w = segRef.current.querySelector<HTMLElement>(`[data-tab="${tab}"]`);
    const pill = segRef.current.querySelector<HTMLElement>(".auth-seg-pill");
    if (w && pill) {
      pill.style.width = w.offsetWidth + "px";
      pill.style.transform = `translateX(${w.offsetLeft - 4}px)`;
    }
  }, [tab]);

  const score = pwScore(pw);
  const emailValid = email && emailOk(email);
  const emailErr = errs.email || (emailBlurred && email && !emailOk(email) ? "Please enter a valid email" : null);
  const pwErr = errs.pw || (tab === "signup" && pwBlurred && pw && score < 2 ? "Make it harder to guess" : null);
  const hour = liveT ? liveT.getHours() : 9;

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    const next: Record<string, string | null> = {};
    if (!identifier) next.identifier = "Email or phone is required";
    if (!pw) next.pw = "Password is required";
    setErrs(next);
    if (Object.keys(next).length) return;
    setSubmitState("loading");
    try {
      const res = await fetch(`${API_URL}/hr/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password: pw }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error?.message || "Login failed");
      setSubmitState("success");
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!reduce) {
        const palette = ["#F5D547", "#5D5FEF", "#4A7C52", "#E07A5F", "#1A1A1A", "#8BA888"];
        const burst = Array.from({ length: 22 }, (_, i) => ({
          id: Date.now() + i,
          c: palette[i % palette.length],
          cx: (Math.random() * 2 - 1) * 220,
          cy: -Math.random() * 180 - 40,
          cr: (Math.random() * 2 - 1) * 540,
          d: Math.random() * 0.18,
        }));
        setConfetti(burst);
        setTimeout(() => setConfetti([]), 1200);
      }
      setTimeout(() => {
        login(data.data.accessToken, data.data.refreshToken, data.data.user);
        router.push("/dashboard");
      }, 800);
    } catch (err: unknown) {
      setErrs({ general: err instanceof Error ? err.message : "Login failed" });
      setSubmitState("idle");
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    const next: Record<string, string | null> = {};
    if (!name.trim()) next.name = "Tell us who you are";
    if (!email) next.email = "Email is required";
    else if (!emailOk(email)) next.email = "Please enter a valid email";
    if (!phoneOk(phone)) next.phone = "That doesn't look like a phone";
    if (!pw) next.pw = "Password is required";
    else if (score < 2) next.pw = "Make it harder to guess";
    if (pw2 && pw2 !== pw) next.pw2 = "Passwords don't match";
    setErrs(next);
    if (Object.keys(next).length) return;
    setSubmitState("loading");
    try {
      const res = await fetch(`${API_URL}/hr/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, phone: phone || undefined, password: pw }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error?.message || "Registration failed");
      setSuccessMsg(data.data.message || "Account created! An admin will approve it shortly.");
      setSubmitState("success");
      setTimeout(() => {
        setTab("signin");
        setIdentifier(email);
        setPw("");
        setSuccessMsg("");
        setSubmitState("idle");
      }, 2500);
    } catch (err: unknown) {
      setErrs({ general: err instanceof Error ? err.message : "Registration failed" });
      setSubmitState("idle");
    }
  }

  return (
    <main className="min-h-screen w-full bg-[#FDFCF0] relative overflow-x-hidden">
      {/* Scroll progress */}
      <div id="auth-scroll-prog" className="fixed top-0 left-0 right-0 h-[3px] z-50 pointer-events-none bg-transparent before:content-[''] before:absolute before:left-0 before:top-0 before:h-full before:w-[--p] before:bg-gradient-to-r before:from-[#5D5FEF] before:via-[#F5D547] before:to-[#E07A5F] before:transition-[width_.15s_linear]" style={{ "--p": "0%" } as React.CSSProperties} />

      {/* Grain */}
      <div className="fixed inset-[-20%] pointer-events-none opacity-[.035] mix-blend-multiply z-[1]"
        style={{ backgroundImage: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.95' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>\")", animation: "auth-grain 8s steps(8) infinite" }}
        aria-hidden="true"
      />

      {/* Ambient dots */}
      <div className="fixed inset-0 pointer-events-none opacity-50"
        style={{ backgroundImage: "radial-gradient(rgba(93,95,239,.18) 1px,transparent 1px)", backgroundSize: "22px 22px" }} />

      {/* ── Header ── */}
      <header className="relative z-10 max-w-[1340px] mx-auto px-6 lg:px-10 pt-6 flex items-center justify-between" style={{ animation: "auth-fadeUp .42s cubic-bezier(0.34,1.45,0.64,1) both", animationDelay: ".04s" }}>
        <a href="#" className="flex items-center gap-3">
          <Mark size={34} />
          <div className="leading-tight">
            <p className="text-[13.5px] font-bold text-[#1A1A1A]">Digital Sukoon</p>
            <p className="text-[11px] text-[#6C6555] font-medium -mt-0.5">Employee Portal</p>
          </div>
        </a>
        <div className="flex items-center gap-2">
          <span className="hidden md:inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white border border-[#D4CBBA] text-[11px] font-bold text-[#3A3A3A]">
            <IcClock className="text-[#5D5FEF]" />
            <span className="font-mono tabular-nums">{liveT ? fmtTime(liveT) : "--:--"}</span>
            <span className="text-[#9C947C] font-mono">IST</span>
          </span>
          <span className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-[#FFF3C4] border border-[#E8C83A]/40 text-[10.5px] font-bold text-[#3A3A3A]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#4A7C52]" style={{ animation: "pulseDot 1.8s ease-in-out infinite" }} />
            All systems normal
          </span>
        </div>
      </header>

      {/* ── Hero + form + right stage ── */}
      <section className="relative z-10 max-w-[1340px] mx-auto px-6 lg:px-10 pt-10 lg:pt-12 pb-16 grid lg:grid-cols-[0.95fr_1.05fr] gap-10 lg:gap-12 items-stretch">

        {/* Left: hero + form */}
        <div className="flex flex-col max-w-[520px] mx-auto lg:mx-0 w-full">

          {/* Eyebrow */}
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white border-2 border-[#1A1A1A] self-start text-[11px] font-bold text-[#3A3A3A]"
            style={{ boxShadow: "2px 2px 0 #F5D547", animation: "auth-fadeUp .42s cubic-bezier(0.34,1.45,0.64,1) .12s both" }}>
            <span className="h-1.5 w-1.5 rounded-full bg-[#5D5FEF]" style={{ animation: "pulseDot 1.8s ease-in-out infinite" }} />
            <span className="font-mono uppercase tracking-[0.16em]">{liveT ? `${greet(hour)} · ${fmtDate(liveT)}` : "Employee Portal"}</span>
          </div>

          {/* Headline */}
          <h1 className="font-display font-semibold text-[#1A1A1A] tracking-[-0.025em] mt-5" style={{ fontSize: "clamp(48px,7vw,80px)", lineHeight: "0.96", animation: "auth-fadeUp .42s cubic-bezier(0.34,1.45,0.64,1) .2s both" }}>
            Welcome<br />
            <span className="italic font-light">back, friend</span>
            <span className="text-[#5D5FEF]">.</span>
          </h1>

          {/* Sub */}
          <p className="text-[#6C6555] text-[16px] mt-5 font-medium leading-snug max-w-[460px]" style={{ animation: "auth-fadeUp .42s cubic-bezier(0.34,1.45,0.64,1) .3s both" }}>
            Submit today's report, check your standup, see the week ahead and clock in — all from one calm place. <span className="font-display italic text-[#3A3A3A]">Empowering your digital journey.</span>
          </p>

          {/* Feature chips */}
          <div className="flex flex-wrap gap-2 mt-5" style={{ animation: "auth-fadeUp .42s cubic-bezier(0.34,1.45,0.64,1) .4s both" }}>
            {[{ l: "Daily update", c: "bg-[#FFF3C4]" }, { l: "Tasks", c: "bg-[#EDEDFD]" }, { l: "Attendance", c: "bg-[#EDF4EE]" }, { l: "Leave", c: "bg-[#FDF0EC]" }, { l: "Salary slips", c: "bg-[#EEF4ED]" }, { l: "Reviews", c: "bg-[#F3EED8]" }].map((c) => (
              <span key={c.l} className={`px-2.5 py-1 rounded-full text-[11px] font-bold text-[#3A3A3A] ${c.c} hover:-translate-y-0.5 transition-transform`} style={{ border: "1.2px solid rgba(26,26,26,.10)" }}>{c.l}</span>
            ))}
          </div>

          {/* CTA buttons */}
          <div className="flex flex-wrap items-center gap-3 mt-7" style={{ animation: "auth-fadeUp .42s cubic-bezier(0.34,1.45,0.64,1) .5s both" }}>
            <button onClick={() => { setTab("signup"); formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
              className="btn-3d inline-flex items-center gap-2 px-5 py-3 rounded-full bg-[#F5D547] text-[#1A1A1A] font-bold text-[13.5px]">
              Create your account <IcArrow />
            </button>
            <button onClick={() => { setTab("signin"); formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
              className="inline-flex items-center gap-2 px-5 py-3 rounded-full bg-white border-2 border-[#1A1A1A] text-[#1A1A1A] font-bold text-[13.5px] hover:bg-[#F3EED8] transition-colors" style={{ boxShadow: "3px 3px 0 #1A1A1A" }}>
              I already have one
            </button>
          </div>

          {/* ── Auth card ── */}
          <div className="auth-reveal relative mt-10" ref={formRef} id="auth-form">
            <div className="absolute inset-[-24px] rounded-[32px] opacity-0 pointer-events-none transition-opacity duration-700 auth-reveal-glow"
              style={{ background: "radial-gradient(circle at 30% 0%,rgba(245,213,71,.20),transparent 60%),radial-gradient(circle at 70% 100%,rgba(93,95,239,.18),transparent 60%)", filter: "blur(20px)", zIndex: -1 }}
            />
            <div className="v3-card p-6 sm:p-7 relative" style={{ animation: "auth-popIn .42s cubic-bezier(0.34,1.45,0.64,1) .6s both" }}>
              <div className="flex items-start justify-between gap-4 mb-5">
                <div>
                  <h2 className="font-display text-[22px] font-semibold text-[#1A1A1A] leading-tight">
                    {tab === "signin" ? "Sign in to clock in." : "Get on the team."}
                  </h2>
                  <p className="text-[12.5px] text-[#6C6555] mt-1 font-medium">
                    {tab === "signin" ? "Use your studio email or phone to pick up where you left off." : "An admin will approve your account once you're in."}
                  </p>
                </div>
              </div>

              {/* Segmented tabs */}
              <div ref={segRef} className="auth-seg mb-5" role="tablist">
                <span className="auth-seg-pill" style={{ width: "50%" }} />
                <button type="button" data-tab="signin" role="tab" aria-selected={tab === "signin"} className={`auth-seg-btn${tab === "signin" ? " active" : ""}`} onClick={() => { setTab("signin"); setErrs({}); setSuccessMsg(""); }}>Sign in</button>
                <button type="button" data-tab="signup" role="tab" aria-selected={tab === "signup"} className={`auth-seg-btn${tab === "signup" ? " active" : ""}`} onClick={() => { setTab("signup"); setErrs({}); setSuccessMsg(""); }}>Create account</button>
              </div>

              {/* Success banner */}
              {successMsg && (
                <div className="mb-4 bg-[#EDF4EE] border border-[#4A7C52]/25 rounded-[14px] px-4 py-3 flex items-center gap-2.5" style={{ animation: "auth-fadeUp .3s ease-out" }}>
                  <IcCheck className="text-[#4A7C52] flex-shrink-0" />
                  <span className="text-[13px] text-[#4A7C52] font-semibold">{successMsg}</span>
                </div>
              )}

              {/* General error */}
              {errs.general && (
                <div className="mb-4 bg-[#FDECEA] border border-[#B83728]/25 rounded-[14px] px-4 py-3 flex items-center gap-2.5" style={{ animation: "auth-fadeUp .3s ease-out" }}>
                  <IcAlert className="text-[#B83728] flex-shrink-0" />
                  <span className="text-[13px] text-[#B83728] font-semibold">{errs.general}</span>
                </div>
              )}

              {/* Forms */}
              {tab === "signin" ? (
                <form onSubmit={handleLogin} noValidate className="space-y-3.5" key="signin">
                  <div style={{ animation: "auth-fadeUp .42s cubic-bezier(0.34,1.45,0.64,1) both" }}>
                    <Field id="s-id" label="Email or phone" Icon={IcMail} value={identifier}
                      onChange={(v) => { setIdentifier(v); if (errs.identifier) setErrs({ ...errs, identifier: null }); }}
                      error={errs.identifier} autoComplete="username" />
                  </div>
                  <div style={{ animation: "auth-fadeUp .42s cubic-bezier(0.34,1.45,0.64,1) .04s both" }}>
                    <Field id="s-pw" label="Password" type="password" Icon={IcLock} value={pw}
                      onChange={(v) => { setPw(v); if (errs.pw) setErrs({ ...errs, pw: null }); }}
                      onBlur={() => setPwBlurred(true)}
                      error={pwErr as string | null}
                      autoComplete="current-password" />
                  </div>
                  <div className="flex items-center justify-between text-[12.5px]" style={{ animation: "auth-fadeUp .42s cubic-bezier(0.34,1.45,0.64,1) .08s both" }}>
                    <label className="inline-flex items-center gap-2 cursor-pointer text-[#3A3A3A] font-semibold">
                      <input type="checkbox" className="w-4 h-4 rounded border-[#D4CBBA] accent-[#5D5FEF]" defaultChecked />
                      Keep me signed in
                    </label>
                    <button type="button" onClick={() => setForgotOpen(true)} className="text-[#5D5FEF] font-semibold hover:underline">Forgot password?</button>
                  </div>
                  <div className="pt-1 relative" style={{ animation: "auth-fadeUp .42s cubic-bezier(0.34,1.45,0.64,1) .12s both" }}>
                    <button
                      type="submit"
                      disabled={submitState === "loading" || submitState === "success"}
                      className="btn-3d w-full flex items-center justify-center gap-2 px-5 py-3.5 rounded-full bg-[#1A1A1A] text-white font-bold text-[14px] relative overflow-visible"
                      aria-live="polite"
                    >
                      {submitState === "idle" && (<><span>Sign in & clock in</span><IcArrow /></>)}
                      {submitState === "loading" && (<><span className="h-[18px] w-[18px] border-[2.5px] border-white/35 border-t-white rounded-full" style={{ animation: "auth-spin .7s linear infinite" }} /><span>One moment…</span></>)}
                      {submitState === "success" && (
                        <>
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#F5D547" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <path d="m5 12 4.5 4.5L19 7" strokeDasharray="24" style={{ animation: "auth-checkmark .42s cubic-bezier(0.22,1,0.36,1) forwards" }} />
                          </svg>
                          <span>Have a great day</span>
                        </>
                      )}
                    </button>
                    {confetti.length > 0 && (
                      <div className="absolute inset-0 pointer-events-none overflow-visible">
                        {confetti.map((c) => (
                          <span key={c.id}
                            className="absolute w-[9px] h-[9px] rounded-[2px] left-1/2 top-1/2"
                            style={{ background: c.c, "--cx": `${c.cx}px`, "--cy": `${c.cy}px`, "--cr": `${c.cr}deg`, animationDelay: `${c.d}s`, animation: "auth-confetti-burst .9s cubic-bezier(.22,1,.36,1) forwards" } as React.CSSProperties}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </form>
              ) : (
                <form onSubmit={handleRegister} noValidate className="space-y-3.5" key="signup">
                  <div style={{ animation: "auth-fadeUp .42s cubic-bezier(0.34,1.45,0.64,1) both" }}>
                    <Field id="r-name" label="Full name" Icon={IcUser} value={name}
                      onChange={(v) => { setName(v); if (errs.name) setErrs({ ...errs, name: null }); }}
                      error={errs.name as string | null} autoComplete="name" />
                  </div>
                  <div style={{ animation: "auth-fadeUp .42s cubic-bezier(0.34,1.45,0.64,1) .04s both" }}>
                    <Field id="r-email" label="Work email" type="email" Icon={IcMail} value={email}
                      onChange={(v) => { setEmail(v); if (errs.email) setErrs({ ...errs, email: null }); }}
                      onBlur={() => setEmailBlurred(true)}
                      error={emailErr as string | null}
                      success={!emailErr && !!emailValid}
                      autoComplete="email"
                      hint="Use your @digitalsukoon.in email" />
                  </div>
                  <div style={{ animation: "auth-fadeUp .42s cubic-bezier(0.34,1.45,0.64,1) .06s both" }}>
                    <Field id="r-phone" label="Phone" type="tel" Icon={IcPhone} value={phone}
                      onChange={(v) => { setPhone(v); if (errs.phone) setErrs({ ...errs, phone: null }); }}
                      error={errs.phone as string | null} autoComplete="tel" optional />
                  </div>
                  <div style={{ animation: "auth-fadeUp .42s cubic-bezier(0.34,1.45,0.64,1) .08s both" }}>
                    <Field id="r-pw" label="Create password" type="password" Icon={IcLock} value={pw}
                      onChange={(v) => { setPw(v); if (errs.pw) setErrs({ ...errs, pw: null }); }}
                      onBlur={() => setPwBlurred(true)}
                      error={pwErr as string | null}
                      autoComplete="new-password" />
                    {pw && (
                      <div className="mt-2 ml-1">
                        <div className="h-[4px] rounded-full bg-[#EDE7D2] overflow-hidden flex gap-[3px]">
                          {[1, 2, 3, 4].map((i) => (
                            <div key={i} className="flex-1 rounded-full transition-colors duration-300"
                              style={{ background: score >= i ? (["", "#B83728", "#C05826", "#E8C83A", "#4A7C52"][score] || "#EDE7D2") : "#EDE7D2" }} />
                          ))}
                        </div>
                        <p className="text-[11.5px] mt-1.5 font-semibold flex items-center justify-between">
                          <span className={["text-[#9C947C]", "text-[#B83728]", "text-[#C05826]", "text-[#E8C83A]", "text-[#4A7C52]"][score]}>{pwLabel[score] || "—"}</span>
                          <span className="text-[#9C947C] font-mono">{pw.length} chars</span>
                        </p>
                      </div>
                    )}
                  </div>
                  <div style={{ animation: "auth-fadeUp .42s cubic-bezier(0.34,1.45,0.64,1) .10s both" }}>
                    <Field id="r-pw2" label="Confirm password" type="password" Icon={IcLock} value={pw2}
                      onChange={(v) => { setPw2(v); if (errs.pw2) setErrs({ ...errs, pw2: null }); }}
                      error={errs.pw2 as string | null}
                      success={!!pw && !!pw2 && pw === pw2}
                      autoComplete="new-password" />
                  </div>
                  <div className="pt-1 relative" style={{ animation: "auth-fadeUp .42s cubic-bezier(0.34,1.45,0.64,1) .14s both" }}>
                    <button
                      type="submit"
                      disabled={submitState === "loading" || submitState === "success"}
                      className="btn-3d w-full flex items-center justify-center gap-2 px-5 py-3.5 rounded-full bg-[#1A1A1A] text-white font-bold text-[14px]"
                      aria-live="polite"
                    >
                      {submitState === "idle" && (<><span>Request my account</span><IcArrow /></>)}
                      {submitState === "loading" && (<><span className="h-[18px] w-[18px] border-[2.5px] border-white/35 border-t-white rounded-full" style={{ animation: "auth-spin .7s linear infinite" }} /><span>One moment…</span></>)}
                      {submitState === "success" && (<><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#F5D547" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4.5 4.5L19 7" strokeDasharray="24" style={{ animation: "auth-checkmark .42s cubic-bezier(0.22,1,0.36,1) forwards" }}/></svg><span>Account requested!</span></>)}
                    </button>
                  </div>
                  <p className="text-[11px] text-[#9C947C] text-center mt-1">After registration, an admin must approve your account before you can log in.</p>
                </form>
              )}

              <p className="text-[11px] text-[#9C947C] text-center mt-5 font-medium">
                By continuing you agree to our{" "}<a href="#" className="underline hover:text-[#1A1A1A]">team handbook</a>{" "}&amp;{" "}<a href="#" className="underline hover:text-[#1A1A1A]">privacy notice</a>.
              </p>
            </div>
          </div>
        </div>

        {/* Right: stage */}
        <aside className="hidden lg:block relative min-h-[820px] lg:sticky lg:top-6" style={{ animation: "auth-slideRight .45s cubic-bezier(0.34,1.3,0.64,1) .3s both" }}>
          <RightStage />
        </aside>
      </section>

      {/* ── A day at DS timeline ── */}
      <section className="relative z-10 max-w-[1340px] mx-auto px-6 lg:px-10 py-14 lg:py-20">
        <div className="auth-reveal max-w-[820px] flex items-end justify-between gap-6 flex-wrap">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-[#5D5FEF] font-bold mb-3">A day at Digital Sukoon</p>
            <h2 className="font-display text-[40px] lg:text-[54px] leading-[0.98] tracking-[-0.02em] font-semibold text-[#1A1A1A]">
              One sign-in, <span className="italic font-light text-[#6C6555]">your whole rhythm.</span>
            </h2>
          </div>
          <div className="v3-card-sm px-3 py-2 flex items-center gap-2 text-[11px] font-bold text-[#3A3A3A]">
            <span className="h-2 w-2 rounded-full bg-[#F5D547]" style={{ animation: "pulseDot 1.8s ease-in-out infinite" }} />
            <span className="font-mono tabular-nums">NOW · {liveT ? fmtTime(liveT) : "--:--"} IST</span>
          </div>
        </div>
        {liveT && <DayTimeline now={liveT} />}
      </section>

      {/* ── Stats strip ── */}
      <section className="relative z-10 max-w-[1340px] mx-auto px-6 lg:px-10 pb-16">
        <div className="auth-reveal v3-card overflow-hidden text-white grid grid-cols-2 md:grid-cols-4 gap-6 lg:gap-10 py-10 lg:py-12 px-6 lg:px-12 relative"
          style={{ background: "#1A1A1A", boxShadow: "6px 6px 0 #F5D547" }}>
          <div className="absolute -top-20 -right-10 w-[260px] h-[260px] rounded-full pointer-events-none" style={{ background: "radial-gradient(circle,rgba(245,213,71,.28),transparent 65%)", filter: "blur(40px)" }} />
          <div className="absolute -bottom-32 -left-10 w-[280px] h-[280px] rounded-full pointer-events-none" style={{ background: "radial-gradient(circle,rgba(93,95,239,.22),transparent 65%)", filter: "blur(40px)" }} />
          {[
            { v: 78,  dec: 0, l: "people on the team",  s: "+12% YoY" },
            { v: 4.9, dec: 1, l: "culture rating",       s: "out of 5" },
            { v: 22,  dec: 0, l: "avg leave days",       s: "actually taken" },
            { v: 0,   dec: 0, l: "all-nighters",         s: "we keep it that way" },
          ].map((stat, i) => (
            <div key={i} className="auth-reveal relative" style={{ transitionDelay: `${i * 120}ms` }}>
              <p className="font-num text-[48px] lg:text-[64px] leading-none font-semibold tabular-nums">
                <CountUp value={stat.v} decimals={stat.dec} />
              </p>
              <p className="text-[13px] mt-2 font-bold">{stat.l}</p>
              <p className="text-[11px] text-[#F5D547] font-mono uppercase tracking-wider mt-1 font-bold">{stat.s}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="relative z-10 max-w-[1340px] mx-auto px-6 lg:px-10 pb-10 flex flex-wrap items-end justify-between gap-6">
        <div className="flex items-center gap-3">
          <Mark size={26} />
          <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-[#6C6555] font-bold">© 2026 Digital Sukoon · Mumbai · Empowering your digital journey</p>
        </div>
        <div className="flex gap-6 text-[12px] font-bold text-[#6C6555]">
          <a href="#" className="hover:text-[#5D5FEF] transition-colors">Handbook</a>
          <a href="#" className="hover:text-[#5D5FEF] transition-colors">Benefits</a>
          <a href="#" className="hover:text-[#5D5FEF] transition-colors">Help</a>
        </div>
      </footer>

      {forgotOpen && <ForgotPasswordModal onClose={() => setForgotOpen(false)} />}
    </main>
  );
}
