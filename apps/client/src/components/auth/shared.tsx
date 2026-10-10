"use client";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertCircle, Eye, EyeOff } from "lucide-react";

/* ── Auth pages share the website's shell ──
   digitalsukoon.com ("Channel Surf", apps/web): a 2px-divided header with the
   brand, ON AIR and an IST clock; a two-column body like its Contact channel —
   an accent-gradient panel on the left, the form on the right — and the LIVE
   ticker footer. Design only: every form still calls the real client auth API. */

const istClock = () => new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata" });

export function AuthShell({
  kicker, title, lines, children, ticker,
}: {
  kicker: string;
  title: ReactNode;
  lines: ReactNode[];
  children: ReactNode;
  ticker?: string[];
}) {
  const [clock, setClock] = useState("");
  useEffect(() => {
    setClock(istClock());
    const t = setInterval(() => setClock(istClock()), 1000);
    return () => clearInterval(t);
  }, []);
  const items = ticker ?? [
    "Client portal", "Book promotion on 100+ owned pages", "Review every draft before it ships",
    "Live engagement on every post", "Facebook · Instagram · YouTube · Snapchat",
  ];
  return (
    <main className="auth-shell">
      <header className="auth-header">
        <Link href="/" className="auth-brand">
          <img src="/logo-mark.svg" alt="" />
          <span>Digital Sukoon</span>
        </Link>
        <span className="auth-onair"><i aria-hidden /> On air</span>
        <span className="auth-chcount">Client portal</span>
        <span className="auth-clock" suppressHydrationWarning>{clock}</span>
        <a className="auth-site" href="https://digitalsukoon.com" target="_blank" rel="noopener noreferrer">digitalsukoon.com ↗</a>
      </header>

      <div className="auth-body">
        <section className="auth-panel">
          <div className="auth-panel-top">
            <p className="auth-kicker">{kicker}</p>
            <h1 className="auth-h1">{title}</h1>
          </div>
          <div className="auth-lines">
            {lines.map((l, i) => <p key={i}>{l}</p>)}
          </div>
        </section>
        <section className="auth-form-col">{children}</section>
      </div>

      <footer className="auth-footer">
        <span className="auth-live">LIVE</span>
        <div className="auth-ticker" aria-hidden>
          <div className="auth-ticker-track">
            {[...items, ...items].map((t, i) => <span key={i} className={i % 2 ? "alt" : ""}>{t}</span>)}
          </div>
        </div>
        <span className="auth-views">© {new Date().getFullYear()} Digital Sukoon</span>
      </footer>
      <AuthStyles />
    </main>
  );
}

/* A labelled field in the site's .field / .input style: uppercase tracked
   label above, a 44px square input with a 2px 25%-white border. */
export function AuthField({
  id, label, type = "text", value, onChange, error, hint, autoComplete, onBlur, placeholder,
  showPass, onToggleShowPass, inputMode,
}: {
  id: string;
  label: string;
  type?: string;
  icon?: ReactNode;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  success?: boolean;
  hint?: string;
  autoComplete?: string;
  onBlur?: () => void;
  placeholder?: string;
  showPass?: boolean;
  onToggleShowPass?: () => void;
  inputMode?: "email" | "tel" | "text";
}) {
  const isPw = type === "password";
  const realType = isPw ? (showPass ? "text" : "password") : type;
  return (
    <label className="auth-field" htmlFor={id}>
      <span className="auth-label">{label}</span>
      <span className="auth-input-wrap">
        <input
          id={id}
          type={realType}
          inputMode={inputMode}
          value={value}
          placeholder={placeholder}
          autoComplete={autoComplete}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          className={`auth-input ${isPw ? "has-eye" : ""}`}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-err` : hint ? `${id}-hint` : undefined}
        />
        {isPw && (
          <button
            type="button"
            aria-label={showPass ? "Hide password" : "Show password"}
            onClick={onToggleShowPass}
            className="auth-eye"
          >
            {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        )}
      </span>
      {error && (
        <span id={`${id}-err`} role="alert" className="auth-field-err"><AlertCircle size={13} /> {error}</span>
      )}
      {!error && hint && <span id={`${id}-hint`} className="auth-field-hint">{hint}</span>}
    </label>
  );
}

/* The site's .chip pair, used as the Sign in / Create account switch. */
export function AuthTabs({ active, signInHref, signUpHref, signUpLabel = "Create account" }: {
  active: "signin" | "signup"; signInHref: string; signUpHref: string; signUpLabel?: string;
}) {
  return (
    <div className="auth-chips" role="tablist" aria-label="Auth options">
      <Link href={signInHref} role="tab" aria-selected={active === "signin"} aria-pressed={active === "signin"} className="auth-chip">Sign in</Link>
      <Link href={signUpHref} role="tab" aria-selected={active === "signup"} aria-pressed={active === "signup"} className="auth-chip">{signUpLabel}</Link>
    </div>
  );
}

export function AuthStyles() {
  return (
    <style jsx global>{`
      @keyframes auth-blink { 0%, 100% { opacity: 1 } 50% { opacity: 0.3 } }
      @keyframes auth-tick { to { transform: translateX(-50%) } }
      @keyframes auth-in { from { opacity: 0; transform: translateY(16px) } to { opacity: 1; transform: none } }
      @keyframes auth-spin { to { transform: rotate(360deg) } }

      .auth-shell {
        min-height: 100vh; min-height: 100dvh; display: grid; grid-template-rows: auto minmax(0, 1fr) auto;
        background: #000; color: #fff; font-family: 'Manrope', system-ui, sans-serif; -webkit-font-smoothing: antialiased;
      }
      .auth-shell a { color: #fff; text-decoration: none; }
      .auth-shell a:hover { color: var(--light); }

      /* Header */
      .auth-header {
        display: flex; align-items: center; gap: clamp(12px, 2vw, 24px); padding: 14px clamp(16px, 3vw, 32px);
        border-bottom: 2px solid var(--divider); font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase;
      }
      .auth-brand { display: flex; align-items: center; gap: 10px; font-weight: 800; letter-spacing: -0.02em; font-size: 18px; text-transform: none; white-space: nowrap; }
      .auth-brand img { width: 32px; height: 32px; display: block; }
      .auth-onair { display: flex; align-items: center; gap: 8px; color: var(--light); }
      .auth-onair i { width: 8px; height: 8px; border-radius: 50%; background: var(--light); animation: auth-blink 1.2s infinite; }
      .auth-chcount { margin-left: auto; color: var(--text-2); white-space: nowrap; }
      .auth-clock { color: var(--text-2); font-variant-numeric: tabular-nums; }
      .auth-site { color: var(--text-2); white-space: nowrap; }

      /* Body: the site's Contact channel — gradient panel + form */
      .auth-body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); min-height: 0; }
      .auth-panel {
        background: linear-gradient(140deg, var(--accent-deep), var(--accent)); padding: clamp(24px, 4vw, 56px);
        display: flex; flex-direction: column; justify-content: space-between; gap: 32px; animation: auth-in 0.5s var(--ease);
      }
      .auth-kicker { margin: 0 0 14px; font-size: 13px; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(255,255,255,0.75); }
      .auth-h1 { margin: 0; font-weight: 800; letter-spacing: -0.05em; font-size: clamp(44px, 6vw, 96px); line-height: 0.92; }
      .auth-h1 em { font-style: normal; color: var(--light); }
      .auth-lines { display: flex; flex-direction: column; gap: 8px; font-size: 15px; line-height: 1.5; color: rgba(255,255,255,0.9); }
      .auth-lines p { margin: 0; max-width: 46ch; }
      .auth-lines a { font-weight: 700; color: #fff; text-decoration: underline; text-underline-offset: 3px; }
      .auth-form-col { padding: clamp(24px, 4vw, 56px); display: flex; flex-direction: column; justify-content: center; animation: auth-in 0.5s var(--ease) 0.08s both; }
      .auth-form-inner { width: 100%; max-width: 440px; margin: 0 auto; display: flex; flex-direction: column; gap: 22px; }
      .auth-form-head h2 { margin: 0; font-weight: 800; letter-spacing: -0.04em; font-size: clamp(28px, 3vw, 40px); line-height: 1; }
      .auth-form-head p { margin: 10px 0 0; font-size: 15px; line-height: 1.5; color: var(--text-2); max-width: 40ch; }

      /* Chips (the sign in / create account switch) */
      .auth-chips { display: flex; flex-wrap: wrap; gap: 8px; }
      .auth-chip {
        font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; padding: 10px 14px;
        border: 2px solid rgba(255, 255, 255, 0.3); background: transparent; color: #fff; cursor: pointer; white-space: nowrap;
      }
      .auth-chip:hover { border-color: var(--light); color: #fff; }
      .auth-chip[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); }

      /* Fields */
      .auth-form { display: flex; flex-direction: column; gap: 14px; }
      .auth-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr)); gap: 14px; }
      .auth-fields .full { grid-column: 1 / -1; }
      .auth-field { display: flex; flex-direction: column; gap: 6px; }
      .auth-label { font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-2); }
      .auth-input-wrap { position: relative; display: block; }
      .auth-input {
        width: 100%; min-height: 44px; padding: 6px 10px; font: inherit; font-size: 14px; letter-spacing: normal; text-transform: none;
        color: #fff; caret-color: var(--accent); background: var(--surface); border: 2px solid var(--input-border); border-radius: 0; outline: none;
        transition: border-color 0.2s;
      }
      .auth-input.has-eye { padding-right: 42px; }
      .auth-input::placeholder { color: var(--muted); }
      .auth-input:hover { border-color: rgba(255, 255, 255, 0.45); }
      .auth-input:focus-visible { border-color: var(--accent); outline: none; }
      .auth-input[aria-invalid="true"] { border-color: #ff8a8a; }
      .auth-input:-webkit-autofill, .auth-input:-webkit-autofill:hover, .auth-input:-webkit-autofill:focus {
        -webkit-text-fill-color: #fff; -webkit-box-shadow: 0 0 0 1000px var(--surface) inset; caret-color: #fff;
      }
      .auth-eye { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); background: none; border: 0; padding: 6px; cursor: pointer; color: var(--text-2); display: grid; place-items: center; }
      .auth-eye:hover { color: #fff; }
      .auth-field-err { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: #ff8a8a; }
      .auth-field-hint { font-size: 12px; color: var(--muted); line-height: 1.4; }
      .auth-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; }
      .auth-link { background: none; border: 0; padding: 0; cursor: pointer; font: inherit; font-size: 13px; font-weight: 700; color: var(--light); }
      .auth-link:hover { color: #fff; text-decoration: underline; text-underline-offset: 3px; }
      .auth-err { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border: 2px solid rgba(255, 138, 138, 0.4); color: #ff8a8a; font-size: 13px; font-weight: 600; }
      .auth-ok { padding: 12px 14px; border: 2px solid rgba(110, 231, 160, 0.4); color: #6ee7a0; font-size: 14px; line-height: 1.5; }

      /* Buttons: the site's .btn */
      .auth-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 10px; cursor: pointer; font: inherit; font-weight: 800; font-size: 16px; line-height: 1.2;
        color: #fff; background: var(--accent); border: 1px solid transparent; border-radius: 0; padding: 16px 24px; white-space: nowrap;
        transition: transform 0.35s var(--ease), background 0.2s; width: 100%;
      }
      .auth-btn:hover:not(:disabled) { background: var(--accent-600); }
      .auth-btn:active:not(:disabled) { background: var(--accent-700); }
      .auth-btn:disabled { opacity: 0.6; cursor: progress; }
      .auth-spinner { width: 16px; height: 16px; border: 2px solid rgba(255,255,255,.35); border-top-color: #fff; border-radius: 50%; animation: auth-spin .7s linear infinite; }
      .auth-fine { font-size: 12px; color: var(--muted); line-height: 1.5; }
      .auth-fine a { color: var(--text-2); text-decoration: underline; text-underline-offset: 3px; }

      /* Strength meter: four hairline segments */
      .auth-meter { display: flex; gap: 3px; height: 4px; }
      .auth-meter span { flex: 1; background: var(--dim); transition: background-color .3s; }
      .auth-meter span.on-1 { background: #ff8a8a; } .auth-meter span.on-2 { background: #f5b445; }
      .auth-meter span.on-3 { background: var(--light); } .auth-meter span.on-4 { background: #6ee7a0; }
      .auth-meter-label { display: flex; justify-content: space-between; margin-top: 6px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-2); }

      /* Footer ticker */
      .auth-footer { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: stretch; border-top: 2px solid var(--divider); font-size: 13px; }
      .auth-live { background: var(--accent); padding: 12px 18px; font-weight: 800; letter-spacing: 0.1em; }
      .auth-ticker { overflow: hidden; white-space: nowrap; display: flex; align-items: center; min-width: 0; }
      .auth-ticker-track { display: inline-flex; gap: 40px; padding-right: 40px; animation: auth-tick 40s linear infinite; }
      .auth-ticker-track .alt { color: var(--light); }
      .auth-views { padding: 12px 18px; border-left: 2px solid var(--divider); color: var(--light); white-space: nowrap; background: #000; }

      /* Modal */
      .auth-modal-overlay { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 16px; background: rgba(0,0,0,.75); }
      .auth-modal { position: relative; width: 100%; max-width: 420px; background: var(--surface); border: 2px solid rgba(255,255,255,.3); padding: 28px; display: flex; flex-direction: column; gap: 14px; animation: auth-in 0.3s var(--ease); }
      .auth-modal h3 { margin: 0; font-weight: 800; letter-spacing: -0.03em; font-size: 24px; }
      .auth-modal p { margin: 0; font-size: 14px; line-height: 1.5; color: var(--text-2); }
      .auth-modal-x { position: absolute; top: 12px; right: 12px; background: none; border: 0; cursor: pointer; color: var(--text-2); padding: 6px; }
      .auth-modal-x:hover { color: #fff; }

      @media (max-width: 899px) {
        .auth-body { grid-template-columns: minmax(0, 1fr); }
        .auth-panel { gap: 24px; }
        .auth-h1 { font-size: clamp(40px, 11vw, 64px); }
        .auth-onair, .auth-clock, .auth-site { display: none; }
      }
      @media (max-width: 699px) {
        .auth-header { padding: 10px 16px; }
        .auth-views { display: none; }
        .auth-footer { grid-template-columns: auto minmax(0, 1fr); }
      }
      @media (prefers-reduced-motion: reduce) {
        .auth-shell *, .auth-shell *::before, .auth-shell *::after { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; }
        .auth-ticker { overflow-x: auto; }
      }
    `}</style>
  );
}
