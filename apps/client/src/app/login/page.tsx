"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { useAuth } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import {
  Mail, Lock, Check, AlertCircle, ArrowRight, X,
  Folder, Calendar, BarChart3, Quote,
} from "lucide-react";
import { AuthField, AuthStyles } from "@/components/auth/shared";

const emailOk = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

function useCounter(target: number, duration = 1400, delay = 0) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setN(target); return; }
    let raf = 0;
    let t0 = 0;
    const start = window.setTimeout(() => {
      const step = (t: number) => {
        if (!t0) t0 = t;
        const p = Math.min(1, (t - t0) / duration);
        setN(Math.round(target * (1 - Math.pow(1 - p, 3))));
        if (p < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    }, delay);
    return () => { cancelAnimationFrame(raf); clearTimeout(start); };
  }, [target, duration, delay]);
  return n;
}

export default function ClientLoginPage() {
  const { login } = useAuth();
  const { data: statsEnv } = useSWR("/public/stats", (url) => apiFetch<any>(url));
  const publicStats = (statsEnv as any)?.data ?? null;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailBlurred, setEmailBlurred] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState("");
  const [submitState, setSubmitState] = useState<"idle" | "loading" | "success">("idle");
  const [forgotOpen, setForgotOpen] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);
  const segRef = useRef<HTMLDivElement>(null);

  const emailValid = email.length > 0 && emailOk(email);
  const emailErr = emailBlurred && email && !emailOk(email) ? "Please enter a valid email" : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!email || !emailOk(email) || !password) {
      setEmailBlurred(true);
      if (!password) setError("Password is required");
      return;
    }
    setSubmitState("loading");
    try {
      await login(email, password);
      setSubmitState("success");
    } catch (err: any) {
      setError(err.message || "Invalid email or password.");
      setSubmitState("idle");
    }
  }

  // Position segmented pill under "Sign in"
  useEffect(() => {
    if (!segRef.current) return;
    const w = segRef.current.querySelector('[data-tab="signin"]') as HTMLElement | null;
    const pill = segRef.current.querySelector(".seg-pill") as HTMLElement | null;
    if (w && pill) {
      pill.style.width = w.offsetWidth + "px";
      pill.style.transform = `translateX(${w.offsetLeft - 4}px)`;
    }
  }, []);

  // Reveal-on-scroll
  useEffect(() => {
    const els = document.querySelectorAll(".reveal");
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
    }, { threshold: 0.15 });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <main className="auth-page min-h-screen w-full bg-bg relative overflow-x-hidden text-ink">
      {/* Ambient mesh + dot grid + grain */}
      <div className="fixed inset-0 cream-mesh pointer-events-none" aria-hidden />
      <div className="fixed inset-0 dots-bg pointer-events-none opacity-50" aria-hidden />
      <div className="grain" aria-hidden />

      {/* Top nav */}
      <header className="relative z-20 max-w-[1340px] mx-auto px-6 lg:px-10 pt-6 flex items-center justify-between auth-fade-up d1">
        <Link href="/" className="flex items-center gap-3">
          <Mark size={34} />
          <div className="leading-tight">
            <p className="text-[13.5px] font-bold text-ink">Digital Sukoon</p>
            <p className="text-[11px] text-ink-3 font-medium font-mono uppercase tracking-[0.16em] -mt-0.5">
              Client review room
            </p>
          </div>
        </Link>
        <nav className="hidden md:flex items-center gap-7 text-[12.5px] font-semibold text-ink-2">
          <a href="https://digitalsukoon.com/work" target="_blank" rel="noopener noreferrer" className="hover:text-indigo transition-colors">Our work</a>
          <a href="#how" className="hover:text-indigo transition-colors">How it works</a>
          <a href="https://digitalsukoon.com/studio" target="_blank" rel="noopener noreferrer" className="hover:text-indigo transition-colors">The studio</a>
          <a href="mailto:hello@digitalsukoon.com" className="hover:text-indigo transition-colors">Contact</a>
        </nav>
        <button
          type="button"
          onClick={() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
          className="hidden sm:inline text-[12.5px] font-bold text-ink-2 hover:text-ink"
        >
          Sign in →
        </button>
      </header>

      {/* HERO */}
      <section className="relative z-10 max-w-[1340px] mx-auto px-6 lg:px-10 pt-12 lg:pt-16 pb-16 grid lg:grid-cols-[1.1fr_1fr] gap-10 lg:gap-14 items-start">
        {/* LEFT: hero text + form */}
        <div>
          <div
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white border-2 border-ink self-start text-[11px] font-bold text-ink-2 auth-fade-up d2"
            style={{ boxShadow: "2px 2px 0 #F5D547" }}
          >
            <span className="ripple-dot" aria-hidden />
            <span className="font-mono-auth uppercase tracking-[0.18em]">
              Private review room · Invite-only
            </span>
          </div>

          <h1 className="mt-6" style={{ fontSize: "clamp(56px,9vw,128px)", lineHeight: "0.92" }}>
            <span className="block display-fraunces text-ink auth-fade-up d3">Less email.</span>
            <span className="block auth-fade-up d4 mt-1">
              <span className="display-fraunces text-ink">More </span>
              <span className="relative inline-block">
                <span className="display-instr text-ink">yes</span>
                <svg className="absolute -bottom-3 left-0 w-full overflow-visible" viewBox="0 0 200 24" preserveAspectRatio="none" aria-hidden>
                  <path d="M4 16 C 50 4, 120 22, 196 10" stroke="#F5D547" strokeWidth="9" fill="none" strokeLinecap="round" className="arc-underline" />
                  <path d="M4 16 C 50 4, 120 22, 196 10" stroke="#1A1A1A" strokeWidth="2.5" fill="none" strokeLinecap="round" className="arc-underline" style={{ animationDelay: "1.05s" }} />
                </svg>
              </span>
              <span className="display-fraunces text-ink">.</span>
            </span>
          </h1>

          <p className="mt-9 text-ink-3 text-[16.5px] lg:text-[18px] max-w-[500px] font-medium leading-snug auth-fade-up d6">
            A private review room where your studio posts drafts, you leave notes that go straight to the right person, and you{" "}
            <span className="font-instr italic text-ink text-[20px] lg:text-[22px]">approve in a tap</span>. No threads. No reply-all. Quiet calm.
          </p>

          <div className="flex flex-wrap items-center gap-3 mt-7 auth-fade-up d7">
            <button
              type="button"
              onClick={() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
              className="btn-3d-y inline-flex items-center gap-2 px-6 py-3.5 rounded-full bg-action text-ink font-bold text-[14.5px] border-2 border-ink"
            >
              Open my review room <ArrowRight size={16} />
            </button>
            <Link
              href="/signup"
              className="inline-flex items-center gap-2 px-5 py-3.5 rounded-full bg-white border-2 border-ink text-ink font-bold text-[14px] hover:bg-muted transition-colors"
              style={{ boxShadow: "3px 3px 0 #1A1A1A" }}
            >
              I have an invite
            </Link>
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-7 auth-fade-up d8 text-[11.5px] text-ink-3 font-mono-auth uppercase tracking-[0.14em]">
            <span className="flex items-center gap-1.5"><Check size={14} className="text-success" /> Read-only by default</span>
            <span className="text-ink-4">·</span>
            <span className="flex items-center gap-1.5"><Check size={14} className="text-success" /> No reply-all</span>
            <span className="text-ink-4">·</span>
            <span className="flex items-center gap-1.5"><Check size={14} className="text-success" /> Audit trail included</span>
          </div>

          {/* Auth card */}
          <div
            ref={formRef}
            id="auth"
            className="v3-card-action p-6 sm:p-7 mt-10 auth-pop-in d9 relative"
            style={{ maxWidth: "480px" }}
          >
            <div
              className="absolute -top-3 -right-3 w-16 h-16 rounded-full bg-action border-2 border-ink grid place-items-center font-instr italic text-[15px] font-medium text-ink leading-none"
              style={{ transform: "rotate(8deg)", boxShadow: "2px 2px 0 #1A1A1A", animation: "auth-stampDrop .9s cubic-bezier(0.34,1.45,0.64,1) .8s both" }}
              aria-hidden
            >
              hello.
            </div>

            <div className="mb-5">
              <h2 className="font-display text-[24px] font-semibold text-ink leading-tight">Welcome back.</h2>
              <p className="font-instr italic text-ink-3 text-[16px] mt-1 leading-snug">
                Your room is exactly where you left it.
              </p>
            </div>

            <div ref={segRef} className="seg mb-5" role="tablist" aria-label="Auth options">
              <span className="seg-pill" style={{ width: "50%" }} aria-hidden />
              <button
                type="button"
                data-tab="signin"
                role="tab"
                aria-selected={true}
                className="seg-btn active"
              >
                Sign in
              </button>
              <Link
                href="/signup"
                data-tab="signup"
                role="tab"
                aria-selected={false}
                className="seg-btn"
              >
                I have an invite
              </Link>
            </div>

            <form onSubmit={handleSubmit} noValidate className="space-y-3.5">
              <div className="auth-fade-up" style={{ animationDelay: ".04s" }}>
                <AuthField
                  id="cemail"
                  label="Email"
                  type="email"
                  icon={<Mail size={16} />}
                  value={email}
                  onChange={(v) => { setEmail(v); if (error) setError(""); }}
                  onBlur={() => setEmailBlurred(true)}
                  error={emailErr}
                  success={!emailErr && emailValid}
                  autoComplete="email"
                />
              </div>

              <div className="auth-fade-up" style={{ animationDelay: ".08s" }}>
                <AuthField
                  id="cpw"
                  label="Password"
                  type="password"
                  icon={<Lock size={16} />}
                  value={password}
                  onChange={(v) => { setPassword(v); if (error) setError(""); }}
                  error={null}
                  autoComplete="current-password"
                  showPass={showPass}
                  onToggleShowPass={() => setShowPass((s) => !s)}
                />
              </div>

              <div className="flex items-center justify-between text-[12.5px] auth-fade-up" style={{ animationDelay: ".12s" }}>
                <label className="inline-flex items-center gap-2 cursor-pointer text-ink-2 font-semibold">
                  <input type="checkbox" className="w-4 h-4 rounded border-border accent-indigo" defaultChecked />
                  Remember me
                </label>
                <button
                  type="button"
                  onClick={() => setForgotOpen(true)}
                  className="text-indigo font-semibold hover:underline"
                >
                  Forgot password?
                </button>
              </div>

              {error && (
                <div role="alert" className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-danger-bg border border-danger/30 auth-fade-up">
                  <AlertCircle size={14} className="text-danger shrink-0" />
                  <span className="text-[12.5px] text-danger font-semibold">{error}</span>
                </div>
              )}

              <div className="pt-1 auth-fade-up" style={{ animationDelay: ".16s" }}>
                <button
                  type="submit"
                  disabled={submitState !== "idle"}
                  className="btn-3d-y w-full flex items-center justify-center gap-2 px-5 py-3.5 rounded-full bg-ink text-white font-bold text-[14px] tracking-tight border-2 border-ink disabled:opacity-70 disabled:cursor-not-allowed"
                  aria-live="polite"
                >
                  {submitState === "idle" && (<><span>Open my review room</span><ArrowRight size={16} /></>)}
                  {submitState === "loading" && (<><span className="auth-spinner" aria-hidden /><span>One moment…</span></>)}
                  {submitState === "success" && (<><Check size={20} color="#F5D547" strokeWidth={3} /><span>Opening your room</span></>)}
                </button>
              </div>
            </form>

            <p className="text-center text-[11px] text-ink-4 mt-5 font-instr italic leading-snug">
              By continuing you agree to our{" "}
              <a href="#" className="underline hover:text-ink not-italic">terms</a> &amp;{" "}
              <a href="#" className="underline hover:text-ink not-italic">privacy notice</a>.
              <br />Your review room is read-only by default.
            </p>
          </div>
        </div>

        {/* RIGHT: dashboard preview + stamp */}
        <aside className="hidden lg:block relative pt-4 pl-8 min-h-[700px]">
          <RightStage publicStats={publicStats} />
        </aside>
      </section>

      {/* Marquee strip */}
      <section
        className="relative z-10 py-5 overflow-hidden mb-12"
        style={{
          borderTop: "2px solid rgba(26,26,26,.10)",
          borderBottom: "2px solid rgba(26,26,26,.10)",
          background: "#1A1A1A",
        }}
        aria-hidden
      >
        <div className="auth-marquee whitespace-nowrap">
          {[0, 1].map((k) => (
            <span key={k} className="flex items-center gap-12 pr-12 font-instr italic text-[28px] lg:text-[36px] text-white">
              <span>approved</span><span className="text-action">✦</span>
              <span>read-only by default</span><span className="text-action">✦</span>
              <span>no reply-all</span><span className="text-action">✦</span>
              <span>quietly opinionated</span><span className="text-action">✦</span>
              <span className="font-display not-italic font-semibold tracking-tight">made in Mumbai &amp; Lisbon</span>
              <span className="text-action">✦</span>
            </span>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="relative z-10 max-w-[1200px] mx-auto px-6 lg:px-10 py-12 lg:py-16">
        <div className="reveal max-w-[760px]">
          <p className="font-mono-auth text-[11px] uppercase tracking-[0.22em] text-indigo font-bold mb-3">A short walk-through</p>
          <h2 className="font-display text-[40px] lg:text-[58px] leading-[0.96] tracking-[-0.02em] font-semibold text-ink">
            Three quiet steps. <span className="display-instr text-ink">No threads.</span>
          </h2>
        </div>

        <div className="grid md:grid-cols-3 gap-5 mt-10">
          {[
            { num: "01", title: "We post the draft",  body: "Your strategist publishes a draft to your room with a deadline and a note about what to look for.", accent: "indigo" as const },
            { num: "02", title: "You read & comment", body: "Tap any frame, sentence or asset and leave a comment. The studio gets a quiet ping — no email.",      accent: "action" as const },
            { num: "03", title: "Approve in a tap",   body: "When it's right, hit approve. The post enters the publish queue with your sign-off attached.",         accent: "sage"   as const },
          ].map((s, i) => {
            const bg = { indigo: "bg-indigo-soft text-indigo", action: "bg-action-soft text-ink-2", sage: "bg-sage-soft text-sage" }[s.accent];
            return (
              <div key={s.num} className="reveal v3-card v3-card-lift p-6" style={{ transitionDelay: `${i * 100}ms` }}>
                <div className="flex items-center justify-between mb-4">
                  <span
                    className={`px-3 py-1 rounded-full font-mono-auth text-[10.5px] font-bold uppercase tracking-wider ${bg}`}
                    style={{ border: "1px solid rgba(26,26,26,.12)" }}
                  >
                    STEP {s.num}
                  </span>
                  <span className="font-instr italic text-[42px] text-ink-4/40 leading-none">{i + 1}</span>
                </div>
                <h3 className="font-display text-[22px] font-semibold text-ink leading-tight">{s.title}</h3>
                <p className="text-[14px] text-ink-3 mt-2 leading-relaxed font-medium">{s.body}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Stat strip */}
      <section className="relative z-10 max-w-[1200px] mx-auto px-6 lg:px-10 py-8">
        <div
          className="reveal v3-card overflow-hidden bg-ink text-white grid grid-cols-2 md:grid-cols-4 gap-6 lg:gap-10 py-10 lg:py-12 px-6 lg:px-12 relative"
          style={{ boxShadow: "5px 5px 0 #F5D547" }}
        >
          <div
            className="absolute -top-20 -right-10 w-[260px] h-[260px] rounded-full pointer-events-none"
            style={{ background: "radial-gradient(circle,rgba(245,213,71,.28),transparent 65%)", filter: "blur(36px)" }}
            aria-hidden
          />
          {[
            { v: "< 24h",  l: "avg. approval time",   s: "versus days by email" },
            { v: "1 place", l: "all feedback lives",  s: "no scattered threads" },
            { v: "100%",   l: "of revisions tracked", s: "full history, always" },
            { v: "∞",      l: "content formats",      s: "Reels, stories, feeds" },
          ].map((s, i) => (
            <div key={i} className="reveal relative" style={{ transitionDelay: `${i * 120}ms` }}>
              <p className="font-display text-[52px] lg:text-[68px] leading-none font-semibold tabular-nums">{s.v}</p>
              <p className="text-[13.5px] mt-2 font-bold">{s.l}</p>
              <p className="text-[11px] text-action font-mono-auth uppercase tracking-wider mt-1 font-bold">{s.s}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Testimonial */}
      <section className="relative z-10 max-w-[900px] mx-auto px-6 py-14 lg:py-20">
        <div className="reveal">
          <div className="text-ink-4/40 -mb-2"><Quote size={22} /></div>
          <p
            className="display-instr text-ink leading-[1.1] tracking-[-0.01em]"
            style={{ fontSize: "clamp(28px,4.5vw,52px)" }}
          >
            "It feels less like a software portal and more like a beautifully laid out folio that's quietly waiting for me. I leave notes, the studio sees them, and we keep moving."
          </p>
          <div className="mt-7 flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-terra-soft border-2 border-terra/30 flex items-center justify-center font-bold text-terra text-[13px]">RM</div>
            <div className="leading-tight">
              <p className="text-[13.5px] font-bold text-ink">Roshni Mehta</p>
              <p className="text-[11px] text-ink-3 font-mono-auth uppercase tracking-wider mt-0.5">Founder · Meher &amp; Co</p>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer
        className="relative z-10 max-w-[1340px] mx-auto px-6 lg:px-10 pb-10 pt-6"
        style={{ borderTop: "1.5px dashed rgba(26,26,26,.15)" }}
      >
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="flex items-center gap-3">
            <Mark size={28} />
            <p className="font-mono-auth text-[10.5px] uppercase tracking-[0.18em] text-ink-3 font-bold">
              © {new Date().getFullYear()} Digital Sukoon · A small studio · Mumbai &amp; Lisbon
            </p>
          </div>
          <div className="flex gap-6 text-[12px] font-bold text-ink-3">
            <a href="https://digitalsukoon.com/terms" target="_blank" rel="noopener noreferrer" className="hover:text-indigo">Terms</a>
            <a href="https://digitalsukoon.com/privacy" target="_blank" rel="noopener noreferrer" className="hover:text-indigo">Privacy</a>
            <a href="mailto:hello@digitalsukoon.com" className="hover:text-indigo">Contact</a>
          </div>
        </div>
      </footer>

      {forgotOpen && <ForgotPasswordModal onClose={() => setForgotOpen(false)} />}

      <AuthStyles />
    </main>
  );
}

/* ─────────── Mark ─────────── */
function Mark({ size = 32 }: { size?: number }) {
  return (
    <div
      className="rounded-xl bg-ink text-white grid place-items-center font-black tracking-widest flex-shrink-0"
      style={{ width: size, height: size, fontSize: size * 0.34 }}
    >
      DS
    </div>
  );
}

/* ─────────── Right composition ─────────── */
function RightStage({ publicStats }: { publicStats: any }) {
  return (
    <div className="relative w-full h-full">
      <div
        className="absolute top-12 -right-8 w-[320px] h-[320px] rounded-full opacity-50 pointer-events-none"
        style={{
          background:
            "conic-gradient(from 0deg, rgba(245,213,71,0), rgba(245,213,71,.5), rgba(93,95,239,.25), rgba(245,213,71,0))",
          filter: "blur(34px)",
        }}
        aria-hidden
      />

      <div className="relative auth-slide-right d3 z-10" style={{ transform: "rotate(1deg)" }}>
        <div className="float-a" style={{ ["--r" as any]: "1deg" }}>
          <DashboardPreview publicStats={publicStats} />
        </div>
      </div>

      <div className="absolute -bottom-6 -right-2 z-30">
        <ApprovedStamp />
      </div>

      <div
        className="absolute -top-2 right-2 z-20 v3-card-sm px-3 py-2 auth-fade-up d8 float-c"
        style={{ ["--r" as any]: "-2deg", transform: "rotate(-2deg)" }}
      >
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-success-bg grid place-items-center text-success">
            <Check size={14} />
          </div>
          <div className="leading-tight">
            <p className="text-[11px] font-bold text-ink">Roshni · 2m ago</p>
            <p className="text-[10px] font-medium text-ink-3 font-mono-auth">approved 3 reels →</p>
          </div>
        </div>
      </div>

      <div
        className="absolute -bottom-4 -left-2 z-20 v3-card-sm px-3 py-2 auth-fade-up d10 float-b"
        style={{ ["--r" as any]: "2deg", transform: "rotate(2deg)" }}
      >
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-indigo dot-pulse" aria-hidden />
          <div className="leading-tight">
            <p className="text-[11px] font-bold text-ink">Otto · Q3 launch</p>
            <p className="text-[10px] font-medium font-mono-auth text-ink-3">3 drafts inside →</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Approved stamp ─────────── */
function ApprovedStamp() {
  return (
    <div className="stamp auth-stamp-drop float-c" style={{ animationDelay: ".8s" }}>
      <svg viewBox="0 0 100 100" className="absolute inset-0 w-full h-full auth-spin-slow stamp-ring" aria-hidden>
        <defs>
          <path id="stamp-circle" d="M 50 50 m -38 0 a 38 38 0 1 1 76 0 a 38 38 0 1 1 -76 0" />
        </defs>
        <text>
          <textPath href="#stamp-circle" startOffset="0">
            DIGITAL SUKOON · APPROVED · VOL III · {new Date().toLocaleString("en-US", { month: "long", year: "numeric" }).toUpperCase()} ·{" "}
          </textPath>
        </text>
      </svg>
      <span className="stamp-core">yes.</span>
    </div>
  );
}

/* ─────────── Dashboard preview ─────────── */
type PendingItem = { who: string; title: string; meta: string; due: string; thumb: string; over: boolean };

const PENDING_ITEMS: PendingItem[] = [
  { who: "Otto Studio",   title: "Reels v3 · Summer Edit",          meta: "30s · 1080p",  due: "Due today",  thumb: "linear-gradient(135deg,#E07A5F,#F5D547)", over: false },
  { who: "Meher & Co",    title: "IG carousel · Cotton story",      meta: "7 slides",     due: "Due tomorrow", thumb: "linear-gradient(135deg,#5D5FEF,#8BA888)", over: false },
  { who: "Caravan Press", title: "Newsletter copy · Issue 24",      meta: "680 words",    due: "Overdue",    thumb: "linear-gradient(135deg,#1A1A1A,#3A3A3A)", over: true },
  { who: "Northstar",     title: "Brand film · Director's cut",     meta: "68s · 4K",     due: "Due Friday", thumb: "linear-gradient(135deg,#8BA888,#5F7C5C)", over: false },
];

function DashboardPreview({ publicStats }: { publicStats: any }) {
  const projTarget  = publicStats?.activeProjects ?? 8;
  const liveTarget  = publicStats?.postsPublishedThisMonth ?? 31;
  const empTarget   = publicStats?.employeeCount ?? 14;
  const proj  = useCounter(projTarget,  1400, 700);
  const sched = useCounter(empTarget,   1500, 800);
  const live  = useCounter(liveTarget,  1700, 900);
  const items = useCounter(4, 1100, 300);

  // Live "today" date in the topstrip
  const [today, setToday] = useState<string | null>(null);
  useEffect(() => {
    const fmt = () => new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short" }).toLowerCase();
    setToday(fmt());
    const t = setInterval(() => setToday(fmt()), 60_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="v3-card-action overflow-hidden w-full" style={{ maxWidth: "520px" }}>
      <div
        className="px-4 h-10 flex items-center justify-between font-mono-auth uppercase tracking-[0.16em] text-[10px]"
        style={{ borderBottom: "1.5px solid rgba(26,26,26,0.07)", background: "#FDFCF0" }}
      >
        <span className="font-bold text-ink-3 flex items-center gap-2">
          <span className="ripple-dot" aria-hidden />
          your review room · live
        </span>
        <span className="text-ink-4 font-bold">today · {today ?? "—"}</span>
      </div>

      <div
        className="px-5 py-4 flex items-start justify-between gap-3 auth-fade-up d3"
        style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}
      >
        <div className="flex-1 min-w-0">
          <h3 className="font-display text-[20px] font-semibold leading-tight text-ink">
            <span className="tabular-nums">{items}</span> items waiting for review
          </h3>
          <p className="text-[11.5px] text-ink-3 mt-0.5 font-medium">
            <span className="text-attention font-bold">1 overdue</span> ·{" "}
            <span className="text-attention font-bold">1 due today</span> · Approvals inbox
          </p>
        </div>
        <button
          type="button"
          className="btn-3d shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-ink text-white text-[11.5px] font-bold border-2 border-ink"
          aria-hidden
          tabIndex={-1}
        >
          Open <ArrowRight size={14} />
        </button>
      </div>

      <ul>
        {PENDING_ITEMS.map((it, i) => (
          <li
            key={it.title}
            className="auth-fade-up"
            style={{ animationDelay: `${0.45 + i * 0.07}s`, borderBottom: i < PENDING_ITEMS.length - 1 ? "1px solid rgba(26,26,26,0.07)" : undefined }}
          >
            <div className="px-4 h-14 flex items-center gap-3">
              <div
                className="w-9 h-9 rounded-lg shrink-0 relative overflow-hidden"
                style={{ background: it.thumb, border: "1.5px solid rgba(26,26,26,.18)" }}
                aria-hidden
              >
                <div
                  className="absolute inset-0"
                  style={{ backgroundImage: "radial-gradient(rgba(255,255,255,.18) 1px,transparent 1px)", backgroundSize: "7px 7px" }}
                />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[12.5px] font-bold text-ink leading-tight truncate">{it.title}</p>
                <p className="text-[10.5px] text-ink-3 font-medium font-mono-auth mt-0.5">{it.who} · {it.meta}</p>
              </div>
              <span
                className={`text-[10.5px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap ${it.over ? "bg-attention-bg text-attention" : "bg-action-soft text-ink-2"}`}
                style={{ border: "1px solid rgba(26,26,26,.10)" }}
              >
                {it.due}
              </span>
            </div>
          </li>
        ))}
      </ul>

      <div
        className="grid grid-cols-3 gap-3 p-4"
        style={{ borderTop: "2px solid rgba(26,26,26,0.07)", background: "#FDFCF0" }}
      >
        {[
          { icon: Folder,    label: "Active projects", value: proj,  accent: "bg-indigo-soft text-indigo" },
          { icon: Calendar,  label: "Studio members",  value: sched, accent: "bg-sage-soft text-sage" },
          { icon: BarChart3, label: "Posts live · 7d", value: live,  accent: "bg-action-soft text-ink-2" },
        ].map((s, i) => {
          const Ic = s.icon;
          return (
            <div key={s.label} className="v3-card-sm p-3 auth-fade-up" style={{ animationDelay: `${0.9 + i * 0.08}s` }}>
              <div className={`h-7 w-7 rounded-lg grid place-items-center ${s.accent}`}>
                <Ic size={14} />
              </div>
              <div className="font-display text-[24px] font-semibold text-ink leading-none mt-2 tabular-nums">{s.value}</div>
              <div className="text-[10.5px] text-ink-3 font-bold mt-1 leading-tight">{s.label}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─────────── Forgot password modal ─────────── */
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
      await apiFetch("/client/auth/forgot-password", {
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div className="v3-card-action p-7 w-full max-w-sm relative" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-4 right-4 text-ink-4 hover:text-ink"
        >
          <X size={16} />
        </button>
        <h2 className="font-display text-[22px] font-semibold text-ink mb-1">Forgot password?</h2>
        {sent ? (
          <p className="text-[13.5px] text-ink-3 mt-3 font-medium">
            If that email is registered, a reset link has been sent. Check your inbox.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4 mt-4">
            <p className="text-[13.5px] text-ink-3 font-medium">
              Enter the email on your client account and we'll send a reset link.
            </p>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="you@company.com"
              className="w-full px-4 py-3 border-2 border-ink/15 rounded-xl text-sm text-ink bg-bg placeholder:text-ink-4 focus:outline-none focus:border-indigo transition-colors"
            />
            {error && <p className="text-xs text-danger font-semibold">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="btn-3d-y w-full py-3 rounded-full bg-ink text-white text-sm font-bold border-2 border-ink disabled:opacity-50"
            >
              {loading ? "Sending…" : "Send reset link"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
