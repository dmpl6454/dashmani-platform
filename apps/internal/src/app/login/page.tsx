"use client";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { GoogleSignIn } from "@/components/google-signin";
import useSWR from "swr";
import {
  Mail, Lock, Eye, EyeOff, Check, AlertCircle, ArrowRight, Shield, X,
} from "lucide-react";

const emailOk = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

function useCounter(target: number, duration = 1400) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setN(target); return; }
    let raf = 0;
    let t0 = 0;
    const step = (t: number) => {
      if (!t0) t0 = t;
      const p = Math.min(1, (t - t0) / duration);
      setN(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return n;
}

export default function LoginPage() {
  const { login, adoptSession } = useAuth();
  // Wired for real this time — the previous "Keep me signed in" checkbox was
  // removed in 2026-05 precisely because it did nothing.
  const [rememberMe, setRememberMe] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailBlurred, setEmailBlurred] = useState(false);
  const [passwordBlurred, setPasswordBlurred] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState("");
  const [submitState, setSubmitState] = useState<"idle" | "loading" | "success">("idle");
  const [forgotOpen, setForgotOpen] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);

  // Arriving from the HR or sales portal with a one-time handoff code (#handoff=, a fragment so it
  // never reaches a server log): exchange it for a session here and go straight in. A used or
  // expired code falls back to the form.
  useEffect(() => {
    const code = new URLSearchParams(window.location.hash.slice(1)).get("handoff") ?? new URLSearchParams(window.location.search).get("handoff");
    if (!code) return;
    window.history.replaceState(null, "", "/login");
    setSubmitState("loading");
    apiFetch<any>("/auth/handoff/exchange", { method: "POST", body: JSON.stringify({ code }) })
      .then((res) => { setSubmitState("success"); adoptSession(res.data); })
      .catch((err: any) => { setError(err?.message || "That sign-in link has expired — sign in below."); setSubmitState("idle"); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emailValid = email.length > 0 && emailOk(email);
  const emailErr = emailBlurred && email && !emailOk(email) ? "Use a valid email"
    : emailBlurred && !email ? "Email is required" : null;
  const passwordErr = passwordBlurred && !password ? "Password is required" : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!email || !emailOk(email) || !password) {
      setEmailBlurred(true);
      setPasswordBlurred(true);
      return;
    }
    setSubmitState("loading");
    try {
      await login(email, password, rememberMe);
      setSubmitState("success");
    } catch (err: any) {
      setError(err.message || "Login failed");
      setSubmitState("idle");
    }
  }

  // Scroll reveals
  useEffect(() => {
    const els = document.querySelectorAll(".reveal");
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) e.target.classList.add("in"); });
    }, { threshold: 0.15 });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <main className="ds-login min-h-screen w-full bg-black relative overflow-x-hidden text-white">
      {/* Ambient background */}
      <div className="fixed inset-0 dot-grid pointer-events-none opacity-70" aria-hidden />
      <div className="fixed -top-40 -left-40 w-[600px] h-[600px] aurora pointer-events-none opacity-50" aria-hidden />
      <div className="fixed -bottom-60 right-[-15%] w-[700px] h-[700px] aurora aurora-2 pointer-events-none opacity-60" aria-hidden />

      {/* Top nav */}
      <header className="relative z-10 max-w-[1320px] mx-auto px-6 lg:px-10 pt-6 flex items-center justify-between auth-fade-up d1">
        <a href="#" className="flex items-center gap-3 group">
          <Logo size={36} />
          <div className="leading-tight">
            <p className="font-mono text-[10px] tracking-[0.22em] uppercase text-[#b8b6ff] font-semibold">Digital Sukoon</p>
            <p className="font-display text-[15px] font-semibold text-white -mt-0.5">Internal · Management</p>
          </div>
        </a>
        <nav className="hidden md:flex items-center gap-7 text-[13px] font-semibold text-[#a7a7b0]">
          <a href="https://digitalsukoon.com" target="_blank" rel="noopener noreferrer" className="hover:text-[#b8b6ff] transition-colors">Studio</a>
          <a href="https://client.digitalsukoon.com" target="_blank" rel="noopener noreferrer" className="hover:text-[#b8b6ff] transition-colors">Clients</a>
          <a href="https://hr.digitalsukoon.com" target="_blank" rel="noopener noreferrer" className="hover:text-[#b8b6ff] transition-colors">HR</a>
          <a href="https://sales.digitalsukoon.com" target="_blank" rel="noopener noreferrer" className="hover:text-[#b8b6ff] transition-colors">Sales</a>
          <a href="https://jobs.digitalsukoon.com" target="_blank" rel="noopener noreferrer" className="hover:text-[#b8b6ff] transition-colors">Careers</a>
        </nav>
        <div className="flex items-center gap-3">
          <span className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#1a1760] border border-[#b8b6ff]/35 text-[11.5px] font-semibold text-[#b8b6ff]">
            <Shield size={13} /> Studio team only
          </span>
        </div>
      </header>

      {/* Hero + form */}
      <section className="relative z-10 max-w-[1320px] mx-auto px-6 lg:px-10 pt-10 lg:pt-16 pb-20 grid lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] gap-10 lg:gap-14 items-stretch">
        {/* Left: hero + form */}
        <div className="flex flex-col min-w-0">
          <div
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#0d0d12] border-2 border-white/25 self-start text-[11.5px] font-semibold text-[#a7a7b0] auth-fade-up d2"
            style={{ boxShadow: "2px 2px 0 #403cfa" }}
          >
            <span className="live-dot" style={{ background: "#403cfa", boxShadow: "0 0 0 3px rgba(64,60,250,.3)" }} />
            <span className="font-mono uppercase tracking-[0.16em]">v3.4 · {new Date().toLocaleString("en-US", { month: "short", year: "numeric" })} release</span>
          </div>

          <h1 className="font-display text-[56px] sm:text-[68px] lg:text-[80px] leading-[0.94] tracking-[-0.025em] font-semibold text-white mt-5 auth-fade-up d3">
            Run the<br />
            studio with<br />
            <span className="italic font-light text-[#403cfa]">one sign-in.</span>
          </h1>

          <p className="text-[#a7a7b0] text-[16px] lg:text-[17.5px] mt-5 max-w-[480px] font-medium leading-snug auth-fade-up d4">
            The command surface for the people who keep Digital Sukoon shipping &mdash;
            operations, content review, hiring, and a live picture of every account, in one calm room.
          </p>

          <div className="flex flex-wrap items-center gap-3 mt-7 auth-fade-up d5">
            <button
              type="button"
              onClick={() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
              className="btn-3d inline-flex items-center gap-2 px-5 py-3 rounded-full bg-[#403cfa] hover:bg-[#322eea] transition-colors text-white font-semibold text-[14px]"
            >
              Sign in to portal <ArrowRight size={16} />
            </button>
            <a
              href="https://client.digitalsukoon.com"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-full bg-transparent border-2 border-white/25 text-white font-semibold text-[14px] hover:bg-[#1a1760] hover:border-[#b8b6ff]/50 transition-colors"
              style={{ boxShadow: "3px 3px 0 rgba(64,60,250,.6)" }}
            >
              I'm a client
            </a>
          </div>

          {/* Auth card */}
          {/* Phones: the sign-in card comes FIRST (before 2026-11-06 it started 870 px down, under the hero). */}
          <div ref={formRef} id="auth" className="v3-card-auth p-6 sm:p-8 order-first lg:order-none mb-10 lg:mb-0 lg:mt-12 auth-pop-in d2 lg:d7 relative">
            <div className="mb-6">
              <h2 className="font-display text-[24px] font-semibold text-white leading-tight">Welcome back.</h2>
              <p className="text-[13px] text-[#a7a7b0] mt-1 font-medium">
                Sign in with your studio email to pick up where you left off.
              </p>
            </div>

            <form onSubmit={handleSubmit} noValidate className="space-y-4">
              <AuthField
                id="email"
                label="Work email"
                type="email"
                icon={<Mail size={16} />}
                value={email}
                onChange={(v) => { setEmail(v); if (error) setError(""); }}
                onBlur={() => setEmailBlurred(true)}
                error={emailErr}
                success={!emailErr && emailValid}
                autoComplete="email"
                hint="Use your @digitalsukoon.com or partner email"
              />

              <AuthField
                id="password"
                label="Password"
                type="password"
                icon={<Lock size={16} />}
                value={password}
                onChange={(v) => { setPassword(v); if (error) setError(""); }}
                onBlur={() => setPasswordBlurred(true)}
                error={passwordErr}
                autoComplete="current-password"
                showPass={showPass}
                onToggleShowPass={() => setShowPass((s) => !s)}
              />

              <div className="flex items-center justify-between text-[12.5px]">
                <label className="flex items-center gap-2 text-[#a7a7b0] font-medium cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-white/25 accent-[#403cfa]"
                  />
                  Keep me signed in for 30 days
                </label>
                <button
                  type="button"
                  onClick={() => setForgotOpen(true)}
                  className="text-[#b8b6ff] font-semibold hover:underline"
                >
                  Forgot password?
                </button>
              </div>

              {error && (
                <div role="alert" className="px-3 py-2 rounded-lg bg-[#ff8a8a]/10 border border-[#ff8a8a]/40 text-[#ff8a8a] text-[12.5px] font-semibold flex items-center gap-2">
                  <AlertCircle size={14} /> {error}
                </div>
              )}

              <div className="pt-1">
                <SubmitBtn state={submitState} />
              </div>
            </form>

            <GoogleSignIn
              rememberMe={rememberMe}
              disabled={submitState !== "idle"}
              onSession={(s) => { setSubmitState("success"); adoptSession(s); }}
              onError={(m) => { setError(m); setSubmitState("idle"); }}
            />

            <p className="text-[11.5px] text-[#a7a7b0] text-center mt-6 font-medium">
              Access is invite-only. Need an account?{" "}
              <a href="mailto:admin@digitalsukoon.com" className="underline text-[#b8b6ff] hover:text-white">Email an admin</a>.
            </p>
          </div>
        </div>

        {/* Right: Live Ops panel — min-w-0 lets the grid column shrink below the
            ticker text's nowrap min-content so the panel never overflows on phones */}
        <aside className="relative min-w-0 min-h-[680px] lg:min-h-[820px] lg:sticky lg:top-8 auth-slide-right d4">
          <OpsPanel />
        </aside>
      </section>

      {/* What's inside */}
      <section className="relative z-10 max-w-[1320px] mx-auto px-6 lg:px-10 py-16 lg:py-24">
        <div className="reveal max-w-[760px]">
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-[#b8b6ff] font-semibold mb-3">What's inside</p>
          <h2 className="font-display text-[40px] lg:text-[52px] leading-[1.02] tracking-[-0.02em] font-semibold text-white">
            Everything the studio runs on, <span className="italic font-light text-[#403cfa]">in one room.</span>
          </h2>
        </div>

        <div className="grid md:grid-cols-3 gap-5 mt-12">
          {[
            { tag: "OPS", title: "Daily standup ledger", body: "See who's in, who's blocked, and what shipped — pulled from reports each morning.", color: "bg-[#1a1760]", icon: "●" },
            { tag: "REVIEW", title: "Approvals inbox", body: "Drafts, captions, deliverables — all routed to the right person with SLAs visible.", color: "bg-[#1a1760]", icon: "◆" },
            { tag: "PEOPLE", title: "Hiring & onboarding", body: "Pipeline through equipment kits and first-week checklists — without leaving the portal.", color: "bg-[#1a1760]", icon: "▲" },
            { tag: "CLIENTS", title: "Account room", body: "Every client's revenue, contracts, deliverables and SLA in one quietly opinionated view.", color: "bg-[#1a1760]", icon: "◐" },
            { tag: "FINANCE", title: "Invoices & runway", body: "AR aging, retainer renewals and a clean export when accounting comes asking.", color: "bg-[#1a1760]", icon: "▮" },
            { tag: "AUDIT", title: "Every change, recorded", body: "Audit trail for approvals, payouts and access — never reconstructed after the fact.", color: "bg-[#1a1760]", icon: "✦" },
          ].map((f, i) => (
            <div
              key={f.title}
              className="reveal ds-feature p-5 hover:-translate-y-0.5 transition-all"
              style={{ transitionDelay: `${i * 40}ms` }}
            >
              <div className={`w-10 h-10 rounded-xl ${f.color} flex items-center justify-center text-[#b8b6ff] font-display text-[18px] mb-4`} style={{ border: "1.5px solid rgba(184,182,255,.25)" }}>
                {f.icon}
              </div>
              <p className="text-[10.5px] uppercase tracking-[0.18em] font-semibold text-[#b8b6ff] mb-1.5">{f.tag}</p>
              <h3 className="font-display text-[19px] font-semibold text-white leading-tight mb-1.5">{f.title}</h3>
              <p className="text-[13.5px] text-[#a7a7b0] font-medium leading-snug">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Marquee strip */}
      <section className="relative z-10 py-8 overflow-hidden" style={{ borderTop: "1.5px dashed rgba(255,255,255,.18)", borderBottom: "1.5px dashed rgba(255,255,255,.18)" }}>
        <div className="marquee whitespace-nowrap font-display italic text-[#a7a7b0] text-[34px] lg:text-[44px] tracking-tight">
          {[0, 1].map((k) => (
            <span key={k} className="flex items-center gap-12 pr-12">
              <span>Quietly opinionated.</span><span className="text-[#403cfa]">★</span>
              <span>Built for studios that ship.</span><span className="text-[#b8b6ff]">◆</span>
              <span>One sign-in, one source of truth.</span><span className="text-[#403cfa]">◐</span>
              <span>Made in Mumbai for the world.</span><span className="text-[#b8b6ff]">●</span>
            </span>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="relative z-10 max-w-[1320px] mx-auto px-6 lg:px-10 pt-6 pb-4 flex flex-wrap items-end justify-between gap-6">
        <div className="flex items-center gap-3">
          <Logo size={28} />
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#a7a7b0] font-semibold">© {new Date().getFullYear()} Digital Sukoon · Mumbai</p>
        </div>
        <div className="flex gap-6 text-[12px] font-semibold text-[#a7a7b0]">
          <a href="mailto:admin@digitalsukoon.com" className="hover:text-white">Contact</a>
        </div>
      </footer>

      {forgotOpen && <ForgotPasswordModal onClose={() => setForgotOpen(false)} />}

      <AuthStyles />
    </main>
  );
}

/* ─────────── Logo ─────────── */
function Logo({ size = 40 }: { size?: number }) {
  return (
    // The brand's circle logo (public/logo.png, the one logo on every subdomain).
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/logo.png" alt="Digital Sukoon" width={size} height={size} className="rounded-full shrink-0" style={{ width: size, height: size }} />
  );
}

/* ─────────── Field ─────────── */
function AuthField({
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
          className="absolute right-3 top-[22px] text-[#a7a7b0] hover:text-white p-1 rounded-md transition-colors"
        >
          {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      )}
      {success && !isPw && (
        <span className="absolute right-3 top-[22px] text-[#8fd19e]">
          <Check size={16} />
        </span>
      )}
      {error && (
        <p id={`${id}-err`} role="alert" className="mt-1.5 ml-1 text-[12px] text-[#ff8a8a] font-semibold flex items-center gap-1.5">
          <AlertCircle size={14} /> {error}
        </p>
      )}
      {!error && hint && (
        <p id={`${id}-hint`} className="mt-1.5 ml-1 text-[11.5px] text-[#a7a7b0] font-medium">{hint}</p>
      )}
    </div>
  );
}

/* ─────────── Submit btn ─────────── */
function SubmitBtn({ state }: { state: "idle" | "loading" | "success" }) {
  return (
    <button
      type="submit"
      disabled={state !== "idle"}
      className="btn-3d w-full flex items-center justify-center gap-2 px-5 py-3.5 rounded-full bg-[#403cfa] hover:bg-[#322eea] transition-colors text-white font-semibold text-[14.5px] tracking-tight disabled:opacity-70 disabled:cursor-not-allowed"
      aria-live="polite"
    >
      {state === "idle" && (<><span>Sign in</span><ArrowRight size={16} /></>)}
      {state === "loading" && (<><span className="auth-spinner" aria-hidden /><span>Signing you in…</span></>)}
      {state === "success" && (<><Check size={20} color="#b8b6ff" strokeWidth={3} /><span>Welcome back</span></>)}
    </button>
  );
}

/* ─────────── Live Ops panel ─────────── */
const tickerSeed = [
  { who: "Aryan Sharma", text: "approved 3 leave requests", at: "2m ago" },
  { who: "Priya Mehta",  text: "submitted Q2 ops report", at: "5m ago" },
  { who: "Rohan Kapoor", text: "published 4 reels to @meher.co", at: "8m ago" },
  { who: "Sneha Patel",  text: "closed 12 client tickets", at: "14m ago" },
  { who: "Kavya Reddy",  text: "onboarded new strategist", at: "22m ago" },
];

function OpsPanel() {
  const { data: statsEnvelope } = useSWR(
    "/public/stats",
    (url: string) => apiFetch<{ employeeCount: number; activeProjects: number; postsPublishedThisMonth: number }>(url),
    { revalidateOnFocus: false, refreshInterval: 3600000 }
  );
  const rawEmployees = (statsEnvelope as any)?.data?.employeeCount ?? 124;
  const rawProjects  = (statsEnvelope as any)?.data?.activeProjects ?? 18;
  const employees = useCounter(rawEmployees);
  const liveProj  = useCounter(rawProjects);
  const approvals = useCounter(7);

  const [clock, setClock] = useState<Date | null>(null);
  useEffect(() => {
    setClock(new Date());
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const hhmm = clock?.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false }) ?? "--:--";
  // toLocaleTimeString({second:"2-digit"}) does NOT zero-pad in en-IN — pad manually
  const ss = clock ? String(clock.getSeconds()).padStart(2, "0") : "--";
  const dayLabel = clock?.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) ?? "";

  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % tickerSeed.length), 3200);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="relative w-full h-full rounded-[28px] overflow-hidden bg-[#0d0d12] text-white" style={{ border: "2px solid rgba(255,255,255,.18)", boxShadow: "8px 8px 0 rgba(64,60,250,.55)" }}>
      <div className="absolute -top-32 -left-20 w-[420px] h-[420px] aurora" />
      <div className="absolute -bottom-40 -right-24 w-[440px] h-[440px] aurora aurora-2" />
      <div className="absolute inset-0 opacity-[0.25]" style={{ backgroundImage: "radial-gradient(rgba(255,255,255,.18) 1px,transparent 1px)", backgroundSize: "22px 22px" }} />

      <div className="relative h-full p-5 sm:p-7 flex flex-col gap-5">
        <div className="flex items-center justify-between auth-slide-right d2">
          <div className="flex items-center gap-2.5">
            <span className="live-dot" />
            <span className="font-mono text-[11px] tracking-[0.18em] uppercase text-white/70">Live · Studio Ops</span>
          </div>
          <div className="font-mono text-[11px] text-white/60 tabular-nums">
            <span className="text-white">{hhmm}</span><span className="opacity-50">:{ss}</span>
            <span className="ml-2 opacity-50">IST</span>
          </div>
        </div>

        <div className="auth-slide-right d3">
          <p className="text-[12px] uppercase tracking-[0.22em] text-white/55 font-semibold mb-2">Internal · {dayLabel}</p>
          <h2 className="font-display text-[42px] leading-[0.98] font-semibold text-white">
            The studio,<br />
            <span className="italic font-light text-[#b8b6ff]">at a glance.</span>
          </h2>
        </div>

        {/* single column under 360px — three-across tiles can't hold the labels there */}
        <div className="grid grid-cols-1 min-[360px]:grid-cols-3 gap-3">
          {[
            { k: "Employees", v: employees, sub: "active", accent: "text-[#b8b6ff]" },
            { k: "Live projects", v: liveProj, sub: "in flight", accent: "text-white" },
            { k: "Approvals", v: approvals, sub: "waiting", accent: "text-[#b8b6ff]" },
          ].map((s, i) => (
            <div key={s.k} className={`auth-fade-up d${i + 4} ops-tile rounded-2xl p-3 sm:p-4 bg-white/[0.04] backdrop-blur-sm`} style={{ border: "1px solid rgba(255,255,255,.10)" }}>
              {/* tighter size/tracking below sm — at 0.14em the labels outgrow the narrow tiles */}
              <p className="text-[9px] sm:text-[10.5px] uppercase tracking-[0.04em] sm:tracking-[0.14em] text-white/55 font-semibold mb-3">{s.k}</p>
              <p className={`font-num text-[32px] leading-none font-semibold tabular-nums ${s.accent}`}>{s.v}</p>
              <p className="text-[11px] text-white/50 mt-2 font-medium">{s.sub}</p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-5 gap-3">
          <div className="col-span-3 auth-fade-up d7 ops-tile rounded-2xl p-4 bg-white/[0.04]" style={{ border: "1px solid rgba(255,255,255,.10)" }}>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[9.5px] sm:text-[10.5px] uppercase tracking-[0.06em] sm:tracking-[0.14em] text-white/55 font-semibold">Throughput · 14d</p>
              <span className="text-[10.5px] font-mono text-[#b8b6ff]">+18.4%</span>
            </div>
            <svg viewBox="0 0 240 60" className="w-full h-[60px]">
              <defs>
                <linearGradient id="ops-grad" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="#403cfa" stopOpacity="0.55" />
                  <stop offset="100%" stopColor="#403cfa" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d="M0 42 L18 38 L36 41 L54 30 L72 33 L90 26 L108 28 L126 20 L144 24 L162 18 L180 14 L198 19 L216 10 L234 12 L240 8 L240 60 L0 60 Z" fill="url(#ops-grad)" />
              <path d="M0 42 L18 38 L36 41 L54 30 L72 33 L90 26 L108 28 L126 20 L144 24 L162 18 L180 14 L198 19 L216 10 L234 12 L240 8" stroke="#b8b6ff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              {[42, 38, 41, 30, 33, 26, 28, 20, 24, 18, 14, 19, 10, 12, 8].map((y, i) => (
                <circle key={i} cx={i * 18} cy={y} r="1.8" fill="#b8b6ff" />
              ))}
            </svg>
          </div>
          <div className="col-span-2 auth-fade-up d8 ops-tile rounded-2xl p-4 bg-white/[0.04]" style={{ border: "1px solid rgba(255,255,255,.10)" }}>
            <p className="text-[9.5px] sm:text-[10.5px] uppercase tracking-[0.06em] sm:tracking-[0.14em] text-white/55 font-semibold mb-3">Today</p>
            <div className="flex items-end gap-1.5 h-[44px]">
              {[14, 22, 18, 30, 26, 38, 33].map((h, i) => (
                <div key={i} className="flex-1 rounded-t" style={{ height: `${h * 1.1}px`, background: i === 6 ? "#403cfa" : "rgba(255,255,255,.18)" }} />
              ))}
            </div>
            <div className="flex justify-between mt-2 text-[9.5px] text-white/40 font-mono uppercase tracking-wider">
              <span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span><span>S</span>
            </div>
          </div>
        </div>

        <div className="auth-fade-up d9 ops-tile rounded-2xl p-4 bg-white/[0.04]" style={{ border: "1px solid rgba(255,255,255,.10)" }}>
          <p className="text-[9.5px] sm:text-[10.5px] uppercase tracking-[0.06em] sm:tracking-[0.14em] text-white/55 font-semibold mb-2.5">Live activity</p>
          <div className="space-y-2 min-h-[60px]">
            {[0, 1].map((off) => {
              const a = tickerSeed[(idx + off) % tickerSeed.length];
              return (
                <div key={`${idx}-${off}`} className="flex items-center gap-3 auth-fade-up" style={{ animationDelay: `${off * 0.06}s` }}>
                  <div className="w-7 h-7 rounded-full bg-[#403cfa] flex items-center justify-center text-[11px] font-semibold text-white flex-shrink-0">
                    {a.who.split(" ").map((x) => x[0]).join("")}
                  </div>
                  <div className="flex-1 min-w-0">
                    {/* line-clamp-2 instead of truncate: on phones the text wraps to a
                        second line instead of cutting mid-word with an ellipsis */}
                    <p className="text-[12.5px] text-white/90 leading-tight line-clamp-2">
                      <span className="font-semibold">{a.who.split(" ")[0]}</span>
                      <span className="text-white/55"> {a.text}</span>
                    </p>
                  </div>
                  <span className="font-mono text-[10px] text-white/40">{a.at}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="mt-auto pt-2 flex items-center justify-between text-[11px] text-white/40 auth-fade-up d10">
          <span className="font-mono uppercase tracking-[0.2em]">DS · MGMT v3.4</span>
          <span className="flex items-center gap-1.5"><Shield size={13} /> Encrypted at rest</span>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Forgot password ─────────── */
function ForgotPasswordModal({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [emailBlurred, setEmailBlurred] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const emailErr = emailBlurred && !email ? "Email is required"
    : emailBlurred && email && !emailOk(email) ? "Use a valid email" : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setEmailBlurred(true);
    if (!email || !emailOk(email)) return;
    setLoading(true);
    setError("");
    try {
      await apiFetch("/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setSent(true);
    } catch (err: any) {
      setError(err.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="v3-card-auth p-7 w-full max-w-sm relative">
        <button onClick={onClose} className="absolute top-4 right-4 text-[#a7a7b0] hover:text-white" aria-label="Close">
          <X size={16} />
        </button>
        <h2 className="font-display text-[22px] font-semibold text-white mb-1">Forgot password?</h2>
        {sent ? (
          <div className="mt-3 space-y-4">
            <p className="text-[13.5px] text-[#a7a7b0] font-medium">
              If that email is registered, a reset link has been sent. Check your inbox — and your spam folder if you don't see it within a minute. The link is valid for 24 hours.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="btn-3d w-full py-3 rounded-full bg-[#403cfa] hover:bg-[#322eea] transition-colors text-white text-sm font-bold"
            >
              Back to sign in
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4 mt-4" noValidate>
            <p className="text-[13.5px] text-[#a7a7b0] font-medium">Enter your email and we'll send you a reset link.</p>
            <div>
              <input
                type="email"
                value={email}
                onChange={(e) => { setEmail(e.target.value); if (error) setError(""); }}
                onBlur={() => setEmailBlurred(true)}
                placeholder="you@digitalsukoon.com"
                aria-invalid={!!emailErr}
                className={`w-full px-4 py-3 border-2 rounded-xl text-sm text-white bg-black placeholder:text-[#5c5c66] focus:outline-none transition-colors ${emailErr ? "border-[#ff8a8a] bg-[#ff8a8a]/5 focus:border-[#ff8a8a]" : "border-white/25 focus:border-[#403cfa]"}`}
              />
              {emailErr && (
                <p role="alert" className="mt-1.5 ml-1 text-[12px] text-[#ff8a8a] font-semibold flex items-center gap-1.5">
                  <AlertCircle size={13} /> {emailErr}
                </p>
              )}
            </div>
            {error && <p className="text-xs text-[#ff8a8a] font-semibold">{error}</p>}
            <button
              type="submit" disabled={loading}
              className="btn-3d w-full py-3 rounded-full bg-[#403cfa] hover:bg-[#322eea] transition-colors text-white text-sm font-bold disabled:opacity-50"
            >
              {loading ? "Sending…" : "Send reset link"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

/* ─────────── Page-scoped CSS ─────────── */
function AuthStyles() {
  return (
    <style jsx global>{`
      @keyframes auth-popIn { 0% { opacity: 0; transform: scale(.93) translateY(6px); } 65% { transform: scale(1.025) translateY(-1px); } 100% { opacity: 1; transform: scale(1) translateY(0); } }
      @keyframes auth-fadeUp { 0% { transform: translateY(14px); opacity: 0; } 100% { transform: translateY(0); opacity: 1; } }
      @keyframes auth-slideInRight { 0% { transform: translateX(28px); opacity: 0; } 100% { transform: translateX(0); opacity: 1; } }
      @keyframes auth-meshDrift { 0% { transform: translate3d(0,0,0) scale(1); } 50% { transform: translate3d(-3%,2%,0) scale(1.08); } 100% { transform: translate3d(0,0,0) scale(1); } }
      @keyframes auth-pulseDot { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
      @keyframes auth-spin { to { transform: rotate(360deg); } }
      @keyframes auth-marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }

      .auth-fade-up { animation: auth-fadeUp .42s cubic-bezier(0.34,1.45,0.64,1) both; }
      .auth-pop-in { animation: auth-popIn .44s cubic-bezier(0.34,1.45,0.64,1) both; }
      .auth-slide-right { animation: auth-slideInRight .42s cubic-bezier(0.34,1.3,0.64,1) both; }

      .d1 { animation-delay: .05s; } .d2 { animation-delay: .13s; } .d3 { animation-delay: .22s; }
      .d4 { animation-delay: .32s; } .d5 { animation-delay: .42s; } .d6 { animation-delay: .52s; }
      .d7 { animation-delay: .62s; } .d8 { animation-delay: .72s; } .d9 { animation-delay: .82s; }
      .d10 { animation-delay: .94s; }

      .dot-grid {
        background-image: radial-gradient(rgba(64,60,250,.22) 1px, transparent 1px);
        background-size: 22px 22px;
        background-position: 0 0;
        animation: auth-meshDrift 28s cubic-bezier(0.22,1,0.36,1) infinite;
      }
      .aurora {
        position: absolute;
        background: radial-gradient(ellipse at center, rgba(64,60,250,.38) 0%, rgba(64,60,250,0) 60%);
        filter: blur(40px);
        animation: auth-meshDrift 22s cubic-bezier(0.22,1,0.36,1) infinite alternate;
        border-radius: 50%;
      }
      .aurora-2 {
        background: radial-gradient(ellipse at center, rgba(10,6,186,.45) 0%, rgba(10,6,186,0) 60%);
        animation-duration: 34s;
        animation-direction: alternate-reverse;
      }

      .v3-card-auth { background: #0d0d12; color: #fff; border: 2px solid rgba(255,255,255,.18); border-radius: 20px; box-shadow: 6px 6px 0 rgba(64,60,250,.45); }
      .ds-feature { background: #0d0d12; border: 1.5px solid rgba(255,255,255,.18); border-radius: 14px; transition: border-color .2s, transform .2s; }
      .ds-feature:hover { border-color: #403cfa; }

      /* The portal body is cream and its scrollbar beige; on this page they showed as a cream
         strip beside the scrollbar and on overscroll. :has() keeps it to this page only. */
      html:has(.ds-login), html:has(.ds-login) body { background: #000; color-scheme: dark; }
      html:has(.ds-login) ::-webkit-scrollbar-thumb { background: rgba(255,255,255,.25); }
      html:has(.ds-login) ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,.45); }

      /* The portal-wide .btn-3d shadow is near-black, invisible on this page's black canvas. */
      .ds-login .btn-3d { box-shadow: 3px 3px 0 #0a06ba; }
      .ds-login .btn-3d:hover:not(:disabled) { box-shadow: 4px 4px 0 #0a06ba; }
      .ds-login .btn-3d:active:not(:disabled) { box-shadow: 1px 1px 0 #0a06ba; }

      .live-dot { width: 7px; height: 7px; border-radius: 99px; background: #4A7C52; box-shadow: 0 0 0 3px rgba(74,124,82,.22); animation: auth-pulseDot 1.8s ease-in-out infinite; display: inline-block; }

      .auth-field-wrap { position: relative; }
      .auth-field {
        width: 100%; background: #000; border: 1.5px solid rgba(255,255,255,.25); border-radius: 14px; caret-color: #403cfa;
        /* right padding leaves room for the eye/success icons (right:12px + 16px) so long
           emails don't collide with them or clip at the border, esp. at the mobile 16px font floor */
        padding: 22px 42px 8px 42px; font: 500 14px/1.2 'Plus Jakarta Sans','Instagram Sans',sans-serif; color: #fff;
        text-overflow: ellipsis;
        transition: border-color .2s, box-shadow .2s, background-color .2s; outline: none;
      }
      .auth-field:hover:not(:focus) { border-color: rgba(255,255,255,.45); }
      .auth-field:focus { border-color: #403cfa; background: #000; box-shadow: 0 0 0 4px rgba(64,60,250,.3); }
      .auth-field.error { border-color: #ff8a8a; background: rgba(255,138,138,.06); box-shadow: 0 0 0 4px rgba(255,138,138,.12); }
      .auth-field.success { border-color: rgba(143,209,158,.6); background: #000; }
      /* Chrome/Safari paint autofilled fields pale yellow with dark text; keep them on the dark field. */
      .auth-field:-webkit-autofill, .auth-field:-webkit-autofill:hover, .auth-field:-webkit-autofill:focus { -webkit-text-fill-color: #fff; -webkit-box-shadow: 0 0 0 1000px #000 inset; caret-color: #403cfa; transition: background-color 9999s; }
      .auth-field-label {
        position: absolute; left: 42px; top: 13px; font-size: 13px; color: #a7a7b0; font-weight: 500;
        pointer-events: none; transition: transform .2s, color .2s, font-size .2s; transform-origin: left top;
      }
      .auth-field-wrap.is-focused .auth-field-label,
      .auth-field-wrap.is-filled .auth-field-label {
        transform: translateY(-9px) scale(.78);
        color: #b8b6ff; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
      }
      .auth-field-wrap.error .auth-field-label { color: #ff8a8a; }
      .auth-field-icon { position: absolute; left: 14px; top: 17px; transform: none; color: #5c5c66; transition: color .2s; pointer-events: none; }
      .auth-field-wrap.is-focused .auth-field-icon { color: #b8b6ff; }
      .auth-field-wrap.error .auth-field-icon { color: #ff8a8a; }

      .auth-spinner { width: 18px; height: 18px; border: 2.5px solid rgba(255,255,255,.35); border-top-color: #FFFFFF; border-radius: 50%; animation: auth-spin .7s linear infinite; }

      .ops-tile { transition: transform .35s cubic-bezier(0.34,1.45,0.64,1); }
      .ops-tile:hover { transform: translate(-2px,-3px); }

      .marquee { display: flex; gap: 48px; animation: auth-marquee 32s linear infinite; will-change: transform; }

      .reveal { opacity: 0; transform: translateY(28px); transition: opacity .7s cubic-bezier(0.22,1,0.36,1), transform .7s cubic-bezier(0.22,1,0.36,1); }
      .reveal.in { opacity: 1; transform: translateY(0); }

      @media (prefers-reduced-motion: reduce) {
        .dot-grid, .aurora, .marquee, .ops-tile { animation: none !important; }
        .reveal { opacity: 1; transform: none; }
      }
    `}</style>
  );
}
