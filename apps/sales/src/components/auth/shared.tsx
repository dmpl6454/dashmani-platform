"use client";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertCircle, Eye, EyeOff, Check } from "lucide-react";
import { countries } from "@/lib/countries";

/* ── Auth pages share the website's shell ──
   Adapted from apps/client/src/components/auth/shared.tsx (apps never import from each other):
   digitalsukoon.com's 2px-divided header, a two-column body like its Contact channel — an
   accent-gradient panel and the form — and the LIVE ticker footer. Design only: every form calls
   the real staff auth API. */

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Decorative tile wall: what the portal does. Not data.
const TILE_NAMES = [
  "Comedy", "Food", "Travel", "Fashion", "Music", "Gaming", "Fitness", "Beauty", "Tech", "Film",
  "Cricket", "Dance", "Cars", "Parenting", "Finance", "Pets", "Art", "News", "Memes", "Books",
  "Football", "Cooking", "Design", "Wellness",
];
const TILE_COUNT = 48;

/** The site's tile wall: 10 tiles light up in the accent every 700 ms (still under reduced motion). */
function TileWall() {
  const [lit, setLit] = useState<Set<number>>(() => new Set([2, 7, 13, 21, 30, 38, 44]));
  useEffect(() => {
    if (reducedMotion()) return;
    const iv = window.setInterval(() => {
      const next = new Set<number>();
      for (let i = 0; i < 10; i++) next.add(Math.floor(Math.random() * TILE_COUNT));
      setLit(next);
    }, 700);
    return () => clearInterval(iv);
  }, []);
  return (
    <div className="auth-tiles" aria-hidden>
      {Array.from({ length: TILE_COUNT }, (_, i) => (
        <div key={i} className={`auth-tile${lit.has(i) ? " on" : ""}${lit.has(i) && i % 3 === 0 ? " hot" : ""}`}>
          <span>{TILE_NAMES[i % TILE_NAMES.length]}</span>
        </div>
      ))}
    </div>
  );
}

const DEFAULT_TICKER = [
  "Digital Sukoon Sales", "Every channel, every platform", "Quotes that become orders",
  "GST invoices to the rupee", "Facebook · Instagram · YouTube · Snapchat", "Payments tracked",
];

export function AuthShell({
  kicker, title, lines, children, ticker,
}: {
  kicker: string;
  title: ReactNode;
  lines: ReactNode[];
  children: ReactNode;
  ticker?: string[];
}) {
  const items = ticker ?? DEFAULT_TICKER;
  return (
    <main className="auth-shell">
      <header className="auth-header">
        <Link href="/" className="auth-brand">
          <img src="/logo-mark.svg" alt="" />
          <span>Digital Sukoon <em>Sales</em></span>
        </Link>
        <span className="auth-onair"><i aria-hidden /> On air</span>
        <span className="auth-chcount">Sales portal</span>
        <a className="auth-site" href="https://digitalsukoon.com" target="_blank" rel="noopener noreferrer">digitalsukoon.com ↗</a>
      </header>

      <div className="auth-body">
        {/* The form comes first in the DOM so that on a phone (one column) tab order, reading
            order and visible order match; at ≥900px CSS moves the panel into the left column. */}
        <section className="auth-form-col">{children}</section>
        <section className="auth-panel">
          <div className="auth-panel-top">
            <p className="auth-kicker">{kicker}</p>
            <h1 className="auth-h1">{title}</h1>
          </div>
          <TileWall />
          <div className="auth-lines">
            {lines.map((l, i) => <p key={i}>{l}</p>)}
          </div>
        </section>
      </div>

      <footer className="auth-footer">
        <span className="auth-live">LIVE</span>
        <div className="auth-ticker" aria-hidden>
          <div className="auth-ticker-track">
            {[...items, ...items].map((t, i) => <span key={i} className={i % 2 ? "alt" : ""}>{t}</span>)}
          </div>
        </div>
        <span className="auth-views"> ·
        </span>
      </footer>
      <AuthStyles />
    </main>
  );
}

/** Suspense fallback for the auth pages: the same shell with a loading line, never a bare spinner. */
export function AuthFallback({ title }: { title: string }) {
  return (
    <AuthShell kicker="Sales portal" title={<>Digital Sukoon <em>Sales.</em></>} lines={[<>Inventory, quotes, orders, GST invoices and payments.</>]}>
      <div className="auth-form-inner">
        <div className="auth-form-head"><h2>{title}</h2><p>Loading…</p></div>
      </div>
    </AuthShell>
  );
}

/* A labelled field in the site's .field / .input style. */
export function AuthField({
  id, label, type = "text", value, onChange, error, hint, autoComplete, onBlur, placeholder,
  showPass, onToggleShowPass, inputMode,
}: {
  id: string;
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
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
            aria-pressed={!!showPass}
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

/** Country picker (ISO 3166-1 alpha-2 values, English names). */
export function AuthCountry({ id, value, onChange, error, label = "Country" }: {
  id: string; value: string; onChange: (v: string) => void; error: string | null; label?: string;
}) {
  // Names come from Intl in the browser; build the list after mount so the static HTML and the
  // first client render agree.
  const [list, setList] = useState<Array<{ code: string; name: string }>>([]);
  useEffect(() => setList(countries()), []);
  return (
    <label className="auth-field" htmlFor={id}>
      <span className="auth-label">{label}</span>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="auth-input auth-select"
        autoComplete="country"
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-err` : undefined}
      >
        <option value="">Select your country</option>
        {list.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
      </select>
      {error && <span id={`${id}-err`} role="alert" className="auth-field-err"><AlertCircle size={13} /> {error}</span>}
    </label>
  );
}

/** A required confirmation checkbox (terms, 18+), square like the rest of the site. */
export function AuthCheck({ id, checked, onChange, error, children }: {
  id: string; checked: boolean; onChange: (v: boolean) => void; error: string | null; children: ReactNode;
}) {
  return (
    <div className="auth-check-wrap">
      <label className="auth-check" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-err` : undefined}
        />
        <span className="auth-box" aria-hidden>{checked && <Check size={13} strokeWidth={3} />}</span>
        <span className="auth-check-text">{children}</span>
      </label>
      {error && <span id={`${id}-err`} role="alert" className="auth-field-err"><AlertCircle size={13} /> {error}</span>}
    </div>
  );
}

/* The site's .chip pair as the Sign in / Create account switch. Two pages, not tabs, so they
   carry link semantics: a nav landmark and aria-current on the page you are on. */
export function AuthTabs({ active, signInHref, signUpHref }: {
  active: "signin" | "signup"; signInHref: string; signUpHref: string;
}) {
  return (
    <nav className="auth-chips" aria-label="Account">
      <Link href={signInHref} aria-current={active === "signin" ? "page" : undefined} className="auth-chip">Sign in</Link>
      <Link href={signUpHref} aria-current={active === "signup" ? "page" : undefined} className="auth-chip">Create account</Link>
    </nav>
  );
}

/** Password strength (shown, not enforced beyond the API's 8-character minimum). */
export const pwScore = (v: string) => {
  let s = 0;
  if (v.length >= 8) s++;
  if (v.length >= 12) s++;
  if (/[A-Z]/.test(v) && /[a-z]/.test(v)) s++;
  if (/\d/.test(v) && /[^A-Za-z0-9]/.test(v)) s++;
  return s;
};
const pwLabel = ["", "Weak", "Fair", "Good", "Strong"];

export function PasswordMeter({ password }: { password: string }) {
  if (!password) return null;
  const score = pwScore(password);
  return (
    <div className="mt-2">
      <div className="auth-meter" aria-hidden>
        {[1, 2, 3, 4].map((i) => <span key={i} className={score >= i ? `on-${score}` : ""} />)}
      </div>
      <div className="auth-meter-label">
        <span>{pwLabel[score] || "—"}</span>
        <span>{password.length} chars</span>
      </div>
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

      .auth-header {
        display: flex; align-items: center; gap: clamp(12px, 2vw, 24px); padding: 14px clamp(16px, 3vw, 32px);
        border-bottom: 2px solid var(--divider); font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; min-width: 0;
      }
      .auth-brand { display: flex; align-items: center; gap: 10px; font-weight: 800; letter-spacing: -0.02em; font-size: 18px; text-transform: none; white-space: nowrap; min-width: 0; }
      .auth-brand em { font-style: normal; color: var(--light); }
      .auth-brand img { width: 32px; height: 32px; display: block; flex-shrink: 0; }
      .auth-onair { display: flex; align-items: center; gap: 8px; color: var(--light); }
      .auth-onair i { width: 8px; height: 8px; border-radius: 50%; background: var(--light); animation: auth-blink 1.2s infinite; }
      .auth-chcount { margin-left: auto; color: var(--text-2); white-space: nowrap; }
      .auth-site { color: var(--text-2); white-space: nowrap; }

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
      .auth-form-col { padding: clamp(24px, 4vw, 56px); display: flex; flex-direction: column; justify-content: center; animation: auth-in 0.5s var(--ease) 0.08s both; min-width: 0; }
      @media (min-width: 900px) { .auth-panel { order: -1; } }
      .auth-form-inner { width: 100%; max-width: 440px; margin: 0 auto; display: flex; flex-direction: column; gap: 22px; }
      .auth-form-head h2 { margin: 0; font-weight: 800; letter-spacing: -0.04em; font-size: clamp(28px, 3vw, 40px); line-height: 1; }
      .auth-form-head p { margin: 10px 0 0; font-size: 15px; line-height: 1.5; color: var(--text-2); max-width: 40ch; }

      .auth-tiles { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 3px; }
      .auth-tile {
        aspect-ratio: 16 / 10; background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(255, 255, 255, 0.10);
        display: flex; align-items: flex-end; padding: 3px 4px; overflow: hidden; transition: background 0.5s, border-color 0.5s;
      }
      .auth-tile span { font-size: 8px; letter-spacing: 0.04em; color: rgba(255, 255, 255, 0.35); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .auth-tile.on { background: rgba(255, 255, 255, 0.16); border-color: var(--light); }
      .auth-tile.on.hot { background: #fff; }
      .auth-tile.on span { color: #fff; }
      .auth-tile.on.hot span { color: var(--accent-deep); }
      @media (max-width: 899px) { .auth-tiles { grid-template-columns: repeat(8, minmax(0, 1fr)); } .auth-tile:nth-child(n + 33) { display: none; } }

      .auth-chips { display: flex; flex-wrap: wrap; gap: 8px; }
      .auth-chip {
        font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; padding: 10px 14px;
        border: 2px solid rgba(255, 255, 255, 0.3); background: transparent; color: #fff; cursor: pointer; white-space: nowrap;
      }
      .auth-chip:hover { border-color: var(--light); color: #fff; }
      .auth-chip[aria-current="page"] { background: var(--accent); border-color: var(--accent); }

      .auth-form { display: flex; flex-direction: column; gap: 14px; }
      .auth-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr)); gap: 14px; }
      .auth-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
      .auth-label { font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-2); }
      .auth-input-wrap { position: relative; display: block; }
      .auth-input {
        width: 100%; max-width: 100%; min-height: 44px; padding: 6px 10px; font: inherit; font-size: 14px; letter-spacing: normal; text-transform: none;
        color: #fff; caret-color: var(--accent); background: var(--surface); border: 2px solid var(--input-border); border-radius: 0; outline: none;
        transition: border-color 0.2s;
      }
      .auth-select { appearance: none; padding-right: 32px; background-image: linear-gradient(45deg, transparent 50%, #a7a7b0 50%), linear-gradient(135deg, #a7a7b0 50%, transparent 50%); background-position: calc(100% - 16px) 50%, calc(100% - 11px) 50%; background-size: 5px 5px; background-repeat: no-repeat; }
      .auth-select option { background: #0d0d12; color: #fff; }
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

      .auth-check-wrap { display: flex; flex-direction: column; gap: 6px; }
      .auth-check { position: relative; display: flex; align-items: flex-start; gap: 10px; cursor: pointer; font-size: 14px; line-height: 1.5; color: var(--text-2); }
      .auth-check input { position: absolute; opacity: 0; width: 20px; height: 20px; margin: 0; cursor: pointer; }
      .auth-box { flex-shrink: 0; width: 20px; height: 20px; margin-top: 1px; border: 2px solid var(--input-border); display: grid; place-items: center; background: var(--surface); color: #fff; }
      .auth-check input:checked + .auth-box { background: var(--accent); border-color: var(--accent); }
      .auth-check input:focus-visible + .auth-box { outline: 2px solid var(--accent); outline-offset: 2px; }
      .auth-check input[aria-invalid="true"] + .auth-box { border-color: #ff8a8a; }
      .auth-check-text a { color: var(--light); text-decoration: underline; text-underline-offset: 3px; }

      .auth-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; flex-wrap: wrap; }
      .auth-link { background: none; border: 0; padding: 0; cursor: pointer; font: inherit; font-size: 13px; font-weight: 700; color: var(--light); }
      .auth-link:hover { color: #fff; text-decoration: underline; text-underline-offset: 3px; }
      .auth-err { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border: 2px solid rgba(255, 138, 138, 0.4); color: #ff8a8a; font-size: 13px; font-weight: 600; }
      .auth-err svg { flex-shrink: 0; }
      .auth-ok { padding: 12px 14px; border: 2px solid rgba(110, 231, 160, 0.4); color: #6ee7a0; font-size: 14px; line-height: 1.5; }

      .auth-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 10px; cursor: pointer; font: inherit; font-weight: 800; font-size: 16px; line-height: 1.2;
        color: #fff; background: var(--accent); border: 1px solid transparent; border-radius: 0; padding: 16px 24px; white-space: nowrap;
        transition: background 0.2s; width: 100%; text-decoration: none;
      }
      .auth-shell a.auth-btn:hover { color: #fff; }
      .auth-btn:hover:not(:disabled) { background: var(--accent-600); }
      .auth-btn:active:not(:disabled) { background: var(--accent-700); }
      .auth-btn:disabled { opacity: 0.6; cursor: progress; }
      .auth-spinner { width: 16px; height: 16px; border: 2px solid rgba(255,255,255,.35); border-top-color: #fff; border-radius: 50%; animation: auth-spin .7s linear infinite; }
      .auth-fine { font-size: 12px; color: var(--muted); line-height: 1.5; margin: 0; }
      .auth-fine a { color: var(--text-2); text-decoration: underline; text-underline-offset: 3px; }

      .auth-google { display: flex; flex-direction: column; gap: 14px; margin-top: 18px; }
      .auth-or { display: flex; align-items: center; gap: 12px; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }
      .auth-or::before, .auth-or::after { content: ""; flex: 1; height: 2px; background: rgba(255, 255, 255, 0.14); }
      .auth-google-slot { min-height: 44px; display: flex; justify-content: center; max-width: 100%; overflow: hidden; }
      .auth-google-slot iframe { border-radius: 0 !important; }
      .auth-google-profile { margin-top: 18px; }
      .auth-google-hello { font-size: 14px; line-height: 1.55; color: var(--text-2); margin: 0; }
      .auth-google-hello strong { color: #fff; overflow-wrap: anywhere; }

      .auth-meter { display: flex; gap: 3px; height: 4px; }
      .auth-meter span { flex: 1; background: var(--dim); transition: background-color .3s; }
      .auth-meter span.on-1 { background: #ff8a8a; } .auth-meter span.on-2 { background: #f5b445; }
      .auth-meter span.on-3 { background: var(--light); } .auth-meter span.on-4 { background: #6ee7a0; }
      .auth-meter-label { display: flex; justify-content: space-between; margin-top: 6px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-2); }

      .auth-footer { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: stretch; border-top: 2px solid var(--divider); font-size: 13px; }
      .auth-live { background: var(--accent); padding: 12px 18px; font-weight: 800; letter-spacing: 0.1em; }
      .auth-ticker { overflow: hidden; white-space: nowrap; display: flex; align-items: center; min-width: 0; }
      .auth-ticker-track { display: inline-flex; gap: 40px; padding-right: 40px; animation: auth-tick 40s linear infinite; }
      .auth-ticker-track .alt { color: var(--light); }
      .auth-views { padding: 12px 18px; border-left: 2px solid var(--divider); color: var(--text-2); white-space: nowrap; background: #000; }
      .auth-views a { color: var(--text-2); }

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
        .auth-onair, .auth-site { display: none; }
        .auth-form-col { padding-bottom: 8px; }
      }
      @media (max-width: 699px) {
        .auth-header { padding: 10px 16px; }
        .auth-brand { font-size: 16px; }
        .auth-chcount { display: none; }
        .auth-tiles { display: none; }
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
