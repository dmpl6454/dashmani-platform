"use client";
import { useState } from "react";
import { AlertCircle, Check, Eye, EyeOff } from "lucide-react";

export function AuthField({
  id, label, type = "text", icon, value, onChange, error, success, hint, autoComplete, onBlur,
  showPass, onToggleShowPass,
}: {
  id: string;
  label: string;
  type?: string;
  icon: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  success?: boolean;
  hint?: string;
  autoComplete?: string;
  onBlur?: () => void;
  showPass?: boolean;
  onToggleShowPass?: () => void;
}) {
  const [focused, setFocused] = useState(false);
  const isPw = type === "password";
  const realType = isPw ? (showPass ? "text" : "password") : type;
  const filled = value.length > 0;
  return (
    <div className={`auth-field-wrap ${error ? "error" : focused ? "is-focused" : ""} ${filled ? "is-filled" : ""}`}>
      <span className="auth-field-icon">{icon}</span>
      <input
        id={id}
        type={realType}
        value={value}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); onBlur?.(); }}
        className={`auth-field ${error ? "error" : ""} ${success ? "success" : ""}`}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-err` : hint ? `${id}-hint` : undefined}
      />
      <label htmlFor={id} className="auth-field-label">{label}</label>
      {isPw && (
        <button
          type="button"
          aria-label={showPass ? "Hide password" : "Show password"}
          onClick={onToggleShowPass}
          className="absolute right-3 top-[22px] text-ink-3 hover:text-ink p-1 rounded-md transition-colors"
        >
          {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      )}
      {success && !isPw && (
        <span className="absolute right-3 top-[22px] text-success">
          <Check size={14} />
        </span>
      )}
      {error && (
        <p id={`${id}-err`} role="alert" className="mt-1.5 ml-1 text-[12px] text-danger font-semibold flex items-center gap-1.5">
          <AlertCircle size={14} /> {error}
        </p>
      )}
      {!error && hint && (
        <p id={`${id}-hint`} className="mt-1.5 ml-1 text-[11.5px] text-ink-4 font-medium">{hint}</p>
      )}
    </div>
  );
}

export function AuthStyles() {
  return (
    <style jsx global>{`
      @keyframes auth-popIn { 0% { opacity: 0; transform: scale(.93) translateY(6px); } 65% { transform: scale(1.025) translateY(-1px); } 100% { opacity: 1; transform: scale(1) translateY(0); } }
      @keyframes auth-fadeUp { 0% { transform: translateY(14px); opacity: 0; } 100% { transform: translateY(0); opacity: 1; } }
      @keyframes auth-slideInRight { 0% { transform: translateX(28px); opacity: 0; } 100% { transform: translateX(0); opacity: 1; } }
      @keyframes auth-pulseDot { 0%,100% { opacity: 1; } 50% { opacity: .4; } }
      @keyframes auth-spin { to { transform: rotate(360deg); } }
      @keyframes auth-checkmark { 0% { stroke-dashoffset: 24; } 100% { stroke-dashoffset: 0; } }
      @keyframes auth-meshDrift { 0% { background-position: 0% 0%; } 50% { background-position: 100% 100%; } 100% { background-position: 0% 0%; } }
      @keyframes auth-drift { 0%,100% { transform: translateY(0) rotate(var(--r,0deg)); } 50% { transform: translateY(-7px) rotate(calc(var(--r,0deg) - .6deg)); } }
      @keyframes auth-marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
      @keyframes auth-underlineDraw { from { stroke-dashoffset: 240; } to { stroke-dashoffset: 0; } }
      @keyframes auth-rotate { from { transform: rotate(0); } to { transform: rotate(360deg); } }
      @keyframes auth-stampDrop {
        0% { transform: translateY(-30px) rotate(0deg) scale(1.4); opacity: 0; }
        55% { transform: translateY(0) rotate(-14deg) scale(1.05); opacity: 1; }
        75% { transform: translateY(-3px) rotate(-12deg) scale(.98); }
        100% { transform: translateY(0) rotate(-12deg) scale(1); opacity: 1; }
      }
      @keyframes auth-ripple { 0% { transform: scale(1); opacity: .4; } 100% { transform: scale(2.2); opacity: 0; } }
      @keyframes auth-scaleIn { 0% { transform: scale(.7); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }

      .auth-fade-up   { animation: auth-fadeUp .46s cubic-bezier(0.34,1.45,0.64,1) both; }
      .auth-pop-in    { animation: auth-popIn .44s cubic-bezier(0.34,1.45,0.64,1) both; }
      .auth-slide-right { animation: auth-slideInRight .50s cubic-bezier(0.34,1.3,0.64,1) both; }
      .auth-scale-in  { animation: auth-scaleIn .42s cubic-bezier(0.34,1.45,0.64,1) both; }
      .auth-stamp-drop { animation: auth-stampDrop .9s cubic-bezier(0.34,1.45,0.64,1) both; transform-origin: center; }
      .auth-spin-slow { animation: auth-rotate 22s linear infinite; }

      .d1 { animation-delay: .04s; } .d2 { animation-delay: .12s; } .d3 { animation-delay: .20s; }
      .d4 { animation-delay: .30s; } .d5 { animation-delay: .40s; } .d6 { animation-delay: .52s; }
      .d7 { animation-delay: .64s; } .d8 { animation-delay: .76s; } .d9 { animation-delay: .90s; }
      .d10 { animation-delay: 1.06s; } .d11 { animation-delay: 1.22s; } .d12 { animation-delay: 1.36s; }

      /* ── Backgrounds ── */
      .cream-mesh {
        background:
          radial-gradient(ellipse 70% 60% at 12% 15%, rgba(245,213,71,.30), transparent 65%),
          radial-gradient(ellipse 60% 55% at 88% 18%, rgba(93,95,239,.18), transparent 65%),
          radial-gradient(ellipse 80% 70% at 50% 95%, rgba(224,122,95,.16), transparent 65%);
        background-size: 200% 200%, 200% 200%, 200% 200%;
        animation: auth-meshDrift 26s cubic-bezier(0.22,1,0.36,1) infinite;
      }
      .dots-bg {
        background-image: radial-gradient(rgba(26,26,26,.10) 1px, transparent 1px);
        background-size: 22px 22px;
      }
      .grain {
        position: absolute; inset: 0; pointer-events: none; opacity: .35; mix-blend-mode: multiply;
        background-image: url("data:image/svg+xml;utf8,<svg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.05 0 0 0 0 0.05 0 0 0 0 0.05 0 0 0 0.35 0'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.35'/></svg>");
      }

      /* ── Card system ── */
      .v3-card        { background: #FFFFFF; border: 2px solid #1A1A1A; border-radius: 20px; box-shadow: 4px 4px 0 rgba(93,95,239,0.13); }
      .v3-card-lift   { transition: transform .22s cubic-bezier(0.34,1.45,0.64,1), box-shadow .22s cubic-bezier(0.34,1.45,0.64,1); }
      .v3-card-lift:hover { transform: translate(-2px,-2px); box-shadow: 6px 6px 0 rgba(93,95,239,0.20); }
      .v3-card-sm     { background: #FFFFFF; border: 1.5px solid rgba(26,26,26,0.14); border-radius: 14px; box-shadow: 2px 2px 0 rgba(93,95,239,0.09); }
      .v3-card-action { background: #FFFFFF; border: 2px solid #1A1A1A; border-radius: 20px; box-shadow: 5px 5px 0 #F5D547; }

      /* ── 3D buttons ── */
      .btn-3d { box-shadow: 3px 3px 0 #1A1A1A; transition: transform .09s ease, box-shadow .09s ease, background-color .14s ease, color .14s ease; position: relative; }
      .btn-3d:hover:not(:disabled)  { transform: translate(-1px,-1px); box-shadow: 4px 4px 0 #1A1A1A; }
      .btn-3d:active:not(:disabled) { transform: translate(2px,2px); box-shadow: 1px 1px 0 #1A1A1A; }
      .btn-3d:disabled { opacity: .7; cursor: not-allowed; }

      .btn-3d-y { box-shadow: 3px 3px 0 #1A1A1A, 5px 5px 0 #F5D547; transition: transform .09s ease, box-shadow .09s ease, background-color .14s ease, color .14s ease; }
      .btn-3d-y:hover:not(:disabled)  { transform: translate(-1px,-1px); box-shadow: 4px 4px 0 #1A1A1A, 6px 6px 0 #F5D547; }
      .btn-3d-y:active:not(:disabled) { transform: translate(2px,2px);  box-shadow: 1px 1px 0 #1A1A1A, 3px 3px 0 #F5D547; }
      .btn-3d-y:disabled { opacity: .7; cursor: not-allowed; }

      /* ── Form field ── */
      .auth-field-wrap { position: relative; }
      .auth-field {
        width: 100%; background: #FDFCF0; border: 1.5px solid #D4CBBA; border-radius: 14px;
        padding: 22px 14px 8px 42px; font: 500 14px/1.2 'Plus Jakarta Sans', sans-serif; color: #1A1A1A;
        transition: border-color .2s cubic-bezier(0.22,1,0.36,1), box-shadow .2s cubic-bezier(0.22,1,0.36,1), background-color .2s cubic-bezier(0.22,1,0.36,1);
        outline: none;
      }
      .auth-field:hover:not(:focus) { border-color: #9C947C; }
      .auth-field:focus { border-color: #5D5FEF; background: #FFFFFF; box-shadow: 0 0 0 3px rgba(93,95,239,0.28); }
      .auth-field.error { border-color: #B83728; background: #FDECEA; box-shadow: 0 0 0 3px rgba(184,55,40,.12); }
      .auth-field.success { border-color: #4A7C52; background: #EDF4EE; }
      .auth-field-label {
        position: absolute; left: 42px; top: 13px; font-size: 13px; color: #6C6555; font-weight: 500;
        pointer-events: none; transition: transform .2s cubic-bezier(0.22,1,0.36,1), color .2s, font-size .2s;
        transform-origin: left top;
      }
      .auth-field-wrap.is-focused .auth-field-label,
      .auth-field-wrap.is-filled .auth-field-label {
        transform: translateY(-9px) scale(.78);
        color: #5D5FEF; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
      }
      .auth-field-wrap.error .auth-field-label { color: #B83728; }
      .auth-field-icon {
        position: absolute; left: 14px; top: 50%; transform: translateY(-50%);
        color: #9C947C; transition: color .2s; pointer-events: none;
      }
      .auth-field-wrap.is-focused .auth-field-icon { color: #5D5FEF; }
      .auth-field-wrap.error .auth-field-icon { color: #B83728; }

      /* ── Segmented control ── */
      .seg {
        position: relative; display: flex; background: #F3EED8;
        border: 1.5px solid rgba(26,26,26,0.09); border-radius: 999px; padding: 4px;
      }
      .seg-btn {
        flex: 1; padding: 10px 14px; font-weight: 700; font-size: 13.5px;
        color: #3A3A3A; border-radius: 999px; cursor: pointer; position: relative; z-index: 2; transition: color .2s;
        background: transparent; border: 0;
      }
      .seg-btn.active { color: #FFFFFF; }
      .seg-pill {
        position: absolute; top: 4px; bottom: 4px; background: #1A1A1A; border-radius: 999px;
        transition: transform .32s cubic-bezier(0.34,1.45,0.64,1), width .32s cubic-bezier(0.34,1.45,0.64,1);
        z-index: 1; box-shadow: 2px 2px 0 #5D5FEF;
      }

      /* ── Strength meter ── */
      .meter { height: 4px; border-radius: 99px; background: #EDE7D2; overflow: hidden; display: flex; gap: 3px; }
      .meter-seg { flex: 1; background: #EDE7D2; border-radius: 99px; transition: background-color .3s cubic-bezier(0.22,1,0.36,1); }
      .meter-seg.on-1 { background: #B83728; }
      .meter-seg.on-2 { background: #C05826; }
      .meter-seg.on-3 { background: #E8C83A; }
      .meter-seg.on-4 { background: #4A7C52; }

      /* ── Spinner ── */
      .auth-spinner { width: 18px; height: 18px; border: 2.5px solid rgba(255,255,255,.35); border-top-color: #FFFFFF; border-radius: 50%; animation: auth-spin .7s linear infinite; }

      /* ── Stamp (Approved sticker) ── */
      .stamp {
        position: relative; width: 160px; height: 160px; border-radius: 50%;
        background: #F5D547; border: 2.5px solid #1A1A1A;
        display: grid; place-items: center; box-shadow: 4px 4px 0 #1A1A1A;
      }
      .stamp::before {
        content: ""; position: absolute; inset: 8px;
        border: 1.5px dashed #1A1A1A; border-radius: 50%; opacity: .6;
      }
      .stamp-ring text {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 9.5px; letter-spacing: .18em; fill: #1A1A1A; font-weight: 700;
      }
      .stamp-core {
        position: absolute; font-family: 'Instrument Serif', serif; font-style: italic;
        font-size: 32px; font-weight: 500; color: #1A1A1A; letter-spacing: -.02em; line-height: 1;
      }
      .stamp-core::before { content: "\\2713  "; font-style: normal; }

      /* ── Display fonts ── */
      .display-instr    { font-family: 'Instrument Serif', Georgia, serif; font-style: italic; font-weight: 400; letter-spacing: -.025em; }
      .display-fraunces { font-family: 'Fraunces', Georgia, serif; font-weight: 600; letter-spacing: -.025em; }
      .font-instr       { font-family: 'Instrument Serif', Georgia, serif; }
      .font-mono-auth   { font-family: 'JetBrains Mono', ui-monospace, monospace; }

      /* ── Drift / pulse ── */
      .float-a { animation: auth-drift 11s ease-in-out infinite; }
      .float-b { animation: auth-drift 14s ease-in-out infinite .8s; }
      .float-c { animation: auth-drift 9s ease-in-out infinite .4s; }
      .dot-pulse { animation: auth-pulseDot 1.8s ease-in-out infinite; }

      /* ── Tiny ✓ chip stamp (marquee posts) ── */
      .ok-stamp {
        position: absolute; top: 8px; right: 8px;
        width: 42px; height: 42px; border-radius: 50%;
        background: #F5D547; border: 2px solid #1A1A1A;
        display: grid; place-items: center; transform: rotate(-12deg);
        box-shadow: 2px 2px 0 #1A1A1A;
        font-family: 'Instrument Serif', serif; font-style: italic; font-weight: 500;
        font-size: 14px; color: #1A1A1A; line-height: 1; letter-spacing: -.02em;
      }
      .ok-stamp::before { content: "\\2713  "; font-style: normal; font-family: inherit; }

      /* ── Hand-drawn underline ── */
      .arc-underline { stroke-dasharray: 240; animation: auth-underlineDraw 1.1s cubic-bezier(0.22,1,0.36,1) .9s both; }

      /* ── Pulse ripple ── */
      .ripple-dot { position: relative; display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #F5D547; vertical-align: middle; }
      .ripple-dot::after { content: ""; position: absolute; inset: 0; border-radius: 50%; background: #F5D547; animation: auth-ripple 2s ease-out infinite; }

      /* ── Marquee ── */
      .auth-marquee { display: flex; gap: 1.5rem; animation: auth-marquee 38s linear infinite; will-change: transform; }

      /* ── Reveal-on-scroll ── */
      .reveal { opacity: 0; transform: translateY(28px); transition: opacity .8s cubic-bezier(0.22,1,0.36,1), transform .8s cubic-bezier(0.22,1,0.36,1); }
      .reveal.in { opacity: 1; transform: translateY(0); }

      /* ── Focus / selection ── */
      .auth-page *:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(93,95,239,.30) !important; border-radius: 8px; }
      .auth-page ::selection { background: #FFF3C4; color: #1A1A1A; }

      @media (prefers-reduced-motion: reduce) {
        .float-a, .float-b, .float-c, .auth-spin-slow, .cream-mesh, .auth-marquee, .dot-pulse { animation: none !important; }
        .reveal { opacity: 1; transform: none; }
        *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
      }
    `}</style>
  );
}
