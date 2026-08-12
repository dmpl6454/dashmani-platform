"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import {
  Mail, Lock, Check, AlertCircle, ArrowRight, ArrowUpRight, X,
  Play, Heart, TrendingUp, Eye, EyeOff,
} from "lucide-react";
import { AuthStyles } from "@/components/auth/shared";

const emailOk = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);


export default function ClientLoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailBlurred, setEmailBlurred] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState("");
  const [submitState, setSubmitState] = useState<"idle" | "loading" | "success">("idle");
  const [forgotOpen, setForgotOpen] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const progRef = useRef<HTMLSpanElement>(null);
  const [greeting, setGreeting] = useState("Welcome");

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

  // Reveal-on-scroll
  useEffect(() => {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
    }, { threshold: 0.14 });
    document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  // Value-band "rise up" on scroll — deterministic getBoundingClientRect check
  // (no IntersectionObserver; fails OPEN / visible if JS misses)
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(".omd-rev"));
    if (!els.length) return;
    els.forEach((el) => el.classList.add("omd-armed"));
    const check = () => {
      const vh = window.innerHeight;
      let remaining = false;
      for (const el of els) {
        if (el.classList.contains("omd-inview")) continue;
        if (el.getBoundingClientRect().top < vh * 0.85) el.classList.add("omd-inview");
        else remaining = true;
      }
      if (!remaining) window.removeEventListener("scroll", check);
    };
    window.addEventListener("scroll", check, { passive: true });
    check(); // initial — reveals immediately if already in view
    return () => window.removeEventListener("scroll", check);
  }, []);

  // Time-based greeting
  useEffect(() => {
    const h = new Date().getHours();
    setGreeting(h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening");
  }, []);

  // Scroll progress bar
  useEffect(() => {
    const onScroll = () => {
      const el = document.documentElement;
      const max = el.scrollHeight - el.clientHeight;
      const p = max > 0 ? el.scrollTop / max : 0;
      if (progRef.current) progRef.current.style.transform = `scaleX(${p})`;
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => { window.removeEventListener("scroll", onScroll); window.removeEventListener("resize", onScroll); };
  }, []);

  // Custom cursor (dot + trailing ring) + magnetic buttons — fine-pointer only
  useEffect(() => {
    if (typeof window === "undefined") return;
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!fine || reduce) return;
    const dot = cursorRef.current, ring = ringRef.current;
    document.body.classList.add("omd-cursor-on");
    let tx = innerWidth / 2, ty = innerHeight / 2, rx = tx, ry = ty, raf = 0;
    const magnets = Array.from(document.querySelectorAll<HTMLElement>(".omd-magnetic"));
    const mag = magnets.map(() => ({ x: 0, y: 0 }));
    const mock = document.querySelector<HTMLElement>(".omd-mock");
    let mtx = 0, mty = 0;
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    const loop = () => {
      rx += (tx - rx) * 0.2; ry += (ty - ry) * 0.2;
      if (dot) dot.style.transform = `translate(${tx}px, ${ty}px)`;
      if (ring) ring.style.transform = `translate(${rx}px, ${ry}px)`;
      magnets.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const d = Math.hypot(tx - cx, ty - cy); const R = 110;
        let mx = 0, my = 0;
        if (d < R) { const f = 1 - d / R; mx = (tx - cx) * 0.35 * f; my = (ty - cy) * 0.35 * f; }
        mag[i].x += (mx - mag[i].x) * 0.2; mag[i].y += (my - mag[i].y) * 0.2;
        el.style.transform = `translate(${mag[i].x.toFixed(2)}px, ${mag[i].y.toFixed(2)}px)`;
      });
      if (mock) {
        const r = mock.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const near = tx > r.left - 220 && tx < r.right + 220 && ty > r.top - 220 && ty < r.bottom + 220;
        const targetX = near ? clamp((tx - cx) / (r.width / 2)) * 4.5 : 0;
        const targetY = near ? clamp((ty - cy) / (r.height / 2)) * -4.5 : 0;
        mtx += (targetX - mtx) * 0.12; mty += (targetY - mty) * 0.12;
        mock.style.transform = `perspective(1000px) rotateY(${mtx.toFixed(2)}deg) rotateX(${mty.toFixed(2)}deg)`;
      }
      raf = requestAnimationFrame(loop);
    };
    const onMove = (e: MouseEvent) => { tx = e.clientX; ty = e.clientY; };
    const onOver = (e: MouseEvent) => {
      const t = (e.target as HTMLElement)?.closest?.("a, button, input, [role='tab'], label, .omd-fillcell, .omd-wm");
      ring?.classList.toggle("grow", !!t);
    };
    addEventListener("mousemove", onMove); addEventListener("mouseover", onOver);
    raf = requestAnimationFrame(loop);
    return () => {
      removeEventListener("mousemove", onMove); removeEventListener("mouseover", onOver);
      cancelAnimationFrame(raf); document.body.classList.remove("omd-cursor-on");
      magnets.forEach((el) => { el.style.transform = ""; });
      if (mock) mock.style.transform = "";
    };
  }, []);

  return (
    <main className="omd">
      <div className="omd-cursor" aria-hidden ref={cursorRef} />
      <div className="omd-cursor-ring" aria-hidden ref={ringRef} />
      <div className="omd-progress" aria-hidden><span ref={progRef} /></div>

      {/* Nav */}
      <header className="omd-nav">
        <div className="omd-nav-inner">
          <Link href="/" className="omd-brand">
            <img src="/logo-mark.svg" alt="Digital Sukoon" className="omd-logo" />
            <span className="omd-brand-txt"><b>Digital&nbsp;Sukoon</b></span>
          </Link>
          <nav className="omd-navlinks">
            <a href="https://digitalsukoon.com/work" target="_blank" rel="noopener noreferrer">Work</a>
            <a href="#how">How it works</a>
            <a href="https://digitalsukoon.com/studio" target="_blank" rel="noopener noreferrer">Studio</a>
            <a href="mailto:hr@digitalsukoon.com">Contact</a>
          </nav>
          <button type="button" className="omd-navcta omd-magnetic" onClick={() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })}>
            Sign in <ArrowUpRight size={16} />
          </button>
        </div>
      </header>

      {/* Hero */}
      <section className="omd-hero">
        <div className="omd-hero-left">
          <span className="omd-eyebrow"><span className="omd-live" aria-hidden /> {greeting} — private client studio, invite only</span>
          <h1 className="omd-h1">
            Your <RotatingWord words={["content", "reels", "stories", "campaigns"]} /><br />
            <span className="omd-accent">approved in a tap.</span>
          </h1>
          <p className="omd-sub">
            The client room for Digital Sukoon. Review every draft, drop notes that reach the
            right strategist, and watch your numbers climb — across every platform, in one place.
          </p>
          <div className="omd-cta-row">
            <button type="button" className="omd-btn omd-btn-primary omd-magnetic" onClick={() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })}>
              Enter your studio <ArrowUpRight size={18} />
            </button>
            <Link href="/signup" className="omd-btn omd-btn-ghost">I have an invite</Link>
          </div>
        </div>

        <div className="omd-hero-right">
          <ProductMockup />
        </div>
      </section>

      {/* Value band — bold blue band replacing the old marquee + stats */}
      <section className="omd-valueband">
        <div className="omd-value">
          <div className="omd-value-head omd-rev">
            <span className="omd-eyebrow">Why teams stay</span>
            <h2 className="omd-value-title">
              One calm room for every<br />post, review &amp; sign-off.
            </h2>
          </div>
          <div className="omd-value-grid">
            {[
              { icon: <Check size={24} />, t: "Approve in a tap", d: "Green-light drafts or leave a note in seconds — no email threads, no feedback lost in a chat." },
              { icon: <Eye size={24} />, t: "See it before it ships", d: "Preview reels, stories and carousels exactly the way they'll land on the feed." },
              { icon: <TrendingUp size={24} />, t: "Watch it perform", d: "Live engagement on every approved post, gathered in one clear view." },
            ].map((f, i) => (
              <div className="omd-value-card omd-rev" key={i} style={{ transitionDelay: `${120 + i * 130}ms` }}>
                <div className="omd-value-ic">{f.icon}</div>
                <h3 className="omd-value-ct">{f.t}</h3>
                <p className="omd-value-cd">{f.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Auth band */}
      <section className="omd-authband" id="auth">
        <div className="omd-authband-copy">
          <span className="omd-kicker">Your private login</span>
          <h2 className="omd-h2">Step into your <span className="omd-accent">studio.</span></h2>
          <ul className="omd-perks">
            <li><span className="omd-perk-ic"><Check size={13} strokeWidth={3} /></span> Every draft in one reviewable feed</li>
            <li><span className="omd-perk-ic"><Check size={13} strokeWidth={3} /></span> Approve or request changes in a tap</li>
            <li><span className="omd-perk-ic"><Check size={13} strokeWidth={3} /></span> Live reach &amp; engagement, every platform</li>
          </ul>
          <p className="omd-note">Access is invite-only. No login yet? <a href="mailto:hello@digitalsukoon.com">Email your strategist</a>.</p>
        </div>

        <div className="omd-cardwrap">
          <div ref={formRef} className="omd-card">
            <div className="omd-card-head">
              <h3>Welcome back</h3>
              <p>Your studio is right where you left it.</p>
            </div>
            <div className="omd-seg" role="tablist" aria-label="Auth options">
              <span className="omd-seg-btn active" role="tab" aria-selected={true}>Sign in</span>
              <Link href="/signup" className="omd-seg-btn" role="tab" aria-selected={false}>I have an invite</Link>
            </div>
            <form onSubmit={handleSubmit} noValidate className="omd-form">
              <div className="omd-field">
                <label htmlFor="cemail">Email</label>
                <div className="omd-input-wrap">
                  <Mail size={17} className="omd-input-ic" />
                  <input
                    id="cemail" type="email" inputMode="email" autoComplete="email"
                    className={`omd-input ${emailErr ? "err" : ""}`}
                    placeholder="you@company.com"
                    value={email}
                    onChange={(e) => { setEmail(e.target.value); if (error) setError(""); }}
                    onBlur={() => setEmailBlurred(true)}
                    aria-invalid={!!emailErr}
                    aria-describedby={emailErr ? "cemail-err" : undefined}
                  />
                  {!emailErr && emailValid && <Check size={16} className="omd-input-ok" strokeWidth={3} />}
                </div>
                {emailErr && <p id="cemail-err" className="omd-field-err"><AlertCircle size={13} /> {emailErr}</p>}
              </div>

              <div className="omd-field">
                <label htmlFor="cpw">Password</label>
                <div className="omd-input-wrap">
                  <Lock size={17} className="omd-input-ic" />
                  <input
                    id="cpw" type={showPass ? "text" : "password"} autoComplete="current-password"
                    className="omd-input"
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); if (error) setError(""); }}
                  />
                  <button type="button" className="omd-eye" onClick={() => setShowPass((s) => !s)} aria-label={showPass ? "Hide password" : "Show password"}>
                    {showPass ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </div>
              </div>

              <div className="omd-row">
                <label className="omd-remember"><input type="checkbox" defaultChecked /> Remember me</label>
                <button type="button" onClick={() => setForgotOpen(true)} className="omd-link">Forgot password?</button>
              </div>
              {error && <div role="alert" className="omd-err"><AlertCircle size={14} /> <span>{error}</span></div>}
              <button type="submit" disabled={submitState !== "idle"} className="omd-btn omd-btn-primary omd-submit omd-magnetic" aria-live="polite">
                {submitState === "idle" && (<><span>Enter your studio</span><ArrowRight size={17} /></>)}
                {submitState === "loading" && (<><span className="auth-spinner" aria-hidden /><span>One moment…</span></>)}
                {submitState === "success" && (<><Check size={18} strokeWidth={3} /><span>Opening…</span></>)}
              </button>
            </form>
            <p className="omd-fineprint">Read-only by default · Protected by end-to-end encryption</p>
          </div>
        </div>
      </section>

      {/* How it works — dark section */}
      <section id="how" className="omd-how">
        <div className="omd-how-head reveal">
          <span className="omd-kicker light">A quiet three-step flow</span>
          <h2 className="omd-h2 light">From draft to <span className="omd-accent">published</span>, no chaos.</h2>
        </div>
        <div className="omd-steps">
          {[
            { n: "01", t: "We drop the draft", b: "Your strategist posts each reel, carousel or story with a deadline and a note on what to check." },
            { n: "02", t: "You review & react", b: "Tap any frame and leave a comment. The right person gets pinged instantly — no reply-all." },
            { n: "03", t: "Approve & we ship", b: "Hit approve and it moves into the publish queue with your sign-off — then track performance." },
          ].map((s, i) => (
            <div className="omd-step reveal" key={s.n} style={{ transitionDelay: `${i * 90}ms` }}>
              <span className="omd-step-num">{s.n}</span>
              <h3>{s.t}</h3>
              <p>{s.b}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Quote */}
      <section className="omd-quote reveal">
        <p>“It stopped feeling like software and started feeling like our brand’s command center. We open it, we approve, we move on.”</p>
      </section>

      {/* Hover-fill nav */}
      <div className="omd-fillnav">
        <a className="omd-fillcell" href="https://digitalsukoon.com/work" target="_blank" rel="noopener noreferrer">
          <span className="fill" aria-hidden /><span className="lbl">Our Work</span><ArrowUpRight className="arw" size={22} />
        </a>
        <a className="omd-fillcell" href="#how"><span className="fill" aria-hidden /><span className="lbl">How It Works</span><ArrowUpRight className="arw" size={22} /></a>
        <a className="omd-fillcell" href="mailto:hr@digitalsukoon.com"><span className="fill" aria-hidden /><span className="lbl">Contact</span><ArrowUpRight className="arw" size={22} /></a>
      </div>

      {/* Footer — giant wordmark + slim baseline */}
      <footer className="omd-footer">
        <PokeWordmark />
        <div className="omd-foot-base">
          <span>© {new Date().getFullYear()} Digital Sukoon</span>
          <span className="omd-footer-online"><span className="omd-live" aria-hidden /> Studio online</span>
          <button type="button" className="omd-totop" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>Back to top ↑</button>
        </div>
      </footer>

      {forgotOpen && <ForgotPasswordModal onClose={() => setForgotOpen(false)} />}
      <AuthStyles />
      <OmdStyles />
    </main>
  );
}

/* ─────────── Rotating headline word (grid-stacked, fixed width) ─────────── */
function RotatingWord({ words }: { words: string[] }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setI((v) => (v + 1) % words.length), 2600);
    return () => clearInterval(t);
  }, [words.length]);
  return (
    <span className="omd-rot">
      {words.map((w, idx) => (
        <span key={idx} aria-hidden={idx !== i} className={`omd-rot-word ${idx === i ? "on" : ""}`}>{w},</span>
      ))}
    </span>
  );
}

/* ─────────── Count-up ─────────── */
function useCountUp(target: number, duration = 1500, delay = 0) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setN(target); return; }
    let raf = 0, t0 = 0;
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

/* ─────────── Animated product mockup ("Review Room") ─────────── */
function ProductMockup() {
  const approved = useCountUp(24, 1500, 400);
  const reach = useCountUp(18, 1600, 600);
  const likes = useCountUp(1284, 1900, 500);
  const CARDS = [
    { t: "Summer Reel · v3", p: "Instagram", c: "#1E5FE0" },
    { t: "Cotton Story set", p: "Instagram", c: "#0D99FF" },
    { t: "Launch teaser", p: "YouTube", c: "#14202B" },
  ];
  const [idx, setIdx] = useState(-1);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setIdx(0); return; }
    let i = 0;
    const t = setInterval(() => { setIdx(i % CARDS.length); i++; }, 2300);
    return () => clearInterval(t);
  }, [CARDS.length]);
  const BARS = [42, 66, 50, 84, 60, 96, 72];

  return (
    <div className="omd-mock">
      <div className="omd-mock-win">
        <div className="omd-mock-topbar">
          <span className="omd-tb-dot" /><span className="omd-tb-dot" /><span className="omd-tb-dot" />
          <span className="omd-mock-title">Review Room</span>
          <span className="omd-mock-live"><span className="omd-live" aria-hidden /> Live</span>
        </div>
        <div className="omd-mock-body">
          <div className="omd-mock-stats">
            <div className="omd-mock-tile">
              <span className="omd-mock-ic orange"><Check size={13} strokeWidth={3} /></span>
              <b>{approved}</b><em>Approved</em>
            </div>
            <div className="omd-mock-tile">
              <span className="omd-mock-ic blue"><TrendingUp size={13} /></span>
              <b>+{reach}%</b><em>Reach · 7d</em>
            </div>
            <div className="omd-mock-chart">
              <span className="omd-mock-chart-l">Engagement</span>
              <div className="omd-mock-bars">
                {BARS.map((h, i) => <span key={i} className="omd-bar" style={{ height: `${h}%`, animationDelay: `${0.4 + i * 0.07}s` }} />)}
              </div>
            </div>
          </div>
          <div className="omd-mock-list">
            {CARDS.map((c, i) => {
              const ok = i === idx;
              return (
                <div className={`omd-mock-card ${ok ? "ok" : ""}`} key={c.t}>
                  <span className="omd-mock-thumb" style={{ background: c.c }} aria-hidden />
                  <div className="omd-mock-txt"><b>{c.t}</b><em>{c.p}</em></div>
                  <span className={`omd-mock-status ${ok ? "ok" : ""}`}>{ok ? <><Check size={11} strokeWidth={3} /> Approved</> : "Pending"}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="omd-mock-phone" aria-hidden>
        <div className="omd-mock-reel">
          <span className="omd-mock-play"><Play size={15} fill="#fff" strokeWidth={0} /></span>
          <span className="omd-mock-reeltag">REEL</span>
        </div>
        <div className="omd-mock-reelbar">
          <span className="omd-mock-like"><Heart size={11} fill="#1E5FE0" strokeWidth={0} /> {likes.toLocaleString()}</span>
          <span className="omd-mock-appr"><Check size={10} strokeWidth={3} /></span>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Giant cursor-reactive wordmark ─────────── */
function PokeWordmark() {
  const WORD = "DigitalSukoon";
  const refs = useRef<(HTMLSpanElement | null)[]>([]);
  const rafRef = useRef<number>(0);
  const ptr = useRef<{ x: number; active: boolean }>({ x: 0, active: false });
  const cur = useRef<number[]>([]);
  const dotsRef = useRef<HTMLSpanElement | null>(null);
  const RADIUS = 170, MAX = 50;
  function loop() {
    const { x, active } = ptr.current;
    let busy = false;
    refs.current.forEach((el, i) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      let target = 0;
      if (active) { const t = Math.max(0, 1 - Math.abs(x - cx) / RADIUS); target = MAX * t * t; }
      const c = cur.current[i] ?? 0;
      const next = c + (target - c) * 0.18;
      cur.current[i] = next;
      if (Math.abs(next - target) > 0.15 || next > 0.15) busy = true;
      const rot = ((x < cx ? -1 : 1) * next) / 9;
      el.style.transform = `translateY(${-next.toFixed(2)}px) rotate(${rot.toFixed(2)}deg)`;
    });
    if (busy || active) rafRef.current = requestAnimationFrame(loop); else rafRef.current = 0;
  }
  function kick() { if (!rafRef.current) rafRef.current = requestAnimationFrame(loop); }
  function onMove(e: React.MouseEvent) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    ptr.current = { x: e.clientX, active: true }; kick();
    const dots = dotsRef.current;
    const block = dots?.parentElement;
    if (dots && block) {
      const r = block.getBoundingClientRect();
      dots.style.setProperty("--mx", `${e.clientX - r.left}px`);
      dots.style.setProperty("--my", `${e.clientY - r.top}px`);
      dots.classList.add("on");
    }
  }
  function onLeave() { ptr.current.active = false; kick(); dotsRef.current?.classList.remove("on"); }
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);
  return (
    <div className="omd-wm-block">
      <span className="omd-wm-dots" ref={dotsRef} aria-hidden />
      <div className="omd-wm" onMouseMove={onMove} onMouseLeave={onLeave} aria-label="Digital Sukoon">
        {WORD.split("").map((ch, i) => (
          <span key={i} ref={(el) => { refs.current[i] = el; }} className={`omd-wm-l ${i === 0 || i === 7 ? "accent" : ""}`}>{ch}</span>
        ))}
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
    setLoading(true); setError("");
    try {
      await apiFetch("/client/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) });
      setSent(true);
    } catch (err: any) { setError(err.message || "Something went wrong"); }
    finally { setLoading(false); }
  }
  return (
    <div className="omd omd-modal-overlay" onClick={onClose}>
      <div className="omd-modal" onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={onClose} aria-label="Close" className="omd-modal-x"><X size={16} /></button>
        <h3>Forgot password?</h3>
        {sent ? (
          <p className="omd-modal-p">If that email is registered, a reset link is on its way. Check your inbox — and spam — within a minute. The link is valid for 24 hours.</p>
        ) : (
          <form onSubmit={handleSubmit} className="omd-modal-form">
            <p className="omd-modal-p">Enter the email on your client account and we’ll send a reset link.</p>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="you@company.com" className="omd-modal-input" />
            {error && <p className="omd-modal-err">{error}</p>}
            <button type="submit" disabled={loading} className="omd-btn omd-btn-primary omd-submit">{loading ? "Sending…" : "Send reset link"}</button>
          </form>
        )}
      </div>
    </div>
  );
}

/* ─────────── Page styles (ohhmydesign-inspired: white / navy / orange) ─────────── */
function OmdStyles() {
  return (
    <style jsx global>{`
      .omd {
        --ink: #14202B; --ink2: #4A6173; --ink3: #8AA6B8; --line: #E5E9EF; --panel: #EEF1F5;
        --canvas: #FFFFFF; --dark: #0E1620; --orange: #1E5FE0; --orange-soft: #E4ECFD; --blue: #0D99FF;
        position: relative; min-height: 100vh; background: var(--canvas); color: var(--ink);
        font-family: 'Hanken Grotesk', system-ui, sans-serif; overflow-x: hidden;
        -webkit-font-smoothing: antialiased;
      }
      .omd ::selection { background: var(--orange); color: #fff; }
      .omd-accent { color: var(--orange); }
      .omd-live { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--orange); box-shadow: 0 0 0 4px rgba(30,95,224,.18); animation: omd-pulse 1.8s ease-in-out infinite; vertical-align: middle; }
      @keyframes omd-pulse { 0%,100% { opacity: 1; } 50% { opacity: .4; } }

      /* ── Custom cursor ── */
      .omd > .omd-cursor, .omd > .omd-cursor-ring { position: fixed; top: 0; left: 0; z-index: 90; border-radius: 50%; pointer-events: none; opacity: 0; will-change: transform; }
      .omd > .omd-cursor { width: 8px; height: 8px; margin: -4px 0 0 -4px; background: var(--orange); transition: opacity .3s; }
      .omd > .omd-cursor-ring { width: 34px; height: 34px; margin: -17px 0 0 -17px; border: 1.5px solid var(--orange); transition: width .2s, height .2s, margin .2s, opacity .3s, background-color .2s; }
      .omd > .omd-cursor-ring.grow { width: 56px; height: 56px; margin: -28px 0 0 -28px; background: rgba(30,95,224,.08); }
      .omd-cursor-on .omd > .omd-cursor, .omd-cursor-on .omd > .omd-cursor-ring { opacity: 1; }

      /* ── Nav ── */
      .omd-nav { position: sticky; top: 0; z-index: 50; background: rgba(251,251,253,.82); backdrop-filter: saturate(1.4) blur(14px); -webkit-backdrop-filter: saturate(1.4) blur(14px); border-bottom: 1px solid var(--line); }
      .omd-nav-inner { max-width: 1280px; margin: 0 auto; padding: 15px 28px; display: flex; align-items: center; gap: 20px; }
      .omd-brand { display: flex; align-items: center; gap: 11px; text-decoration: none; }
      .omd-logo { width: 42px; height: 42px; object-fit: contain; display: block; }
      .omd-brand-txt { display: flex; flex-direction: column; line-height: 1.1; }
      .omd-brand-txt b { font-family: 'Bricolage Grotesque', sans-serif; font-weight: 700; font-size: 16px; color: var(--ink); }
      .omd-brand-txt em { font-style: normal; font-family: 'Space Mono', monospace; font-size: 10px; text-transform: uppercase; letter-spacing: .12em; color: var(--ink3); }
      .omd-navlinks { margin-left: auto; display: flex; gap: 30px; }
      .omd-navlinks a { position: relative; font-family: 'Space Mono', monospace; font-size: 12.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink2); text-decoration: none; transition: color .15s; }
      .omd-navlinks a::after { content: ""; position: absolute; left: 0; right: 0; bottom: -5px; height: 2px; background: var(--orange); transform: scaleX(0); transform-origin: right; transition: transform .28s cubic-bezier(0.22,1,0.36,1); }
      .omd-navlinks a:hover { color: var(--orange); }
      .omd-navlinks a:hover::after { transform: scaleX(1); transform-origin: left; }

      /* ── Scroll progress bar ── */
      .omd-progress { position: fixed; top: 0; left: 0; right: 0; height: 3px; z-index: 60; pointer-events: none; }
      .omd-progress > span { display: block; height: 100%; width: 100%; transform: scaleX(0); transform-origin: left; background: linear-gradient(90deg, #1E5FE0, #3B77E8 60%, #0B45BB); }
      .omd-navcta { -webkit-appearance: none; appearance: none; display: inline-flex; align-items: center; gap: 7px; padding: 11px 20px; border-radius: 999px; border: 0; cursor: pointer; font-weight: 700; font-size: 14px; color: #fff; background: var(--ink); transition: background-color .18s; }
      .omd-navcta:hover { background: var(--orange); }
      @media (max-width: 900px) { .omd-navlinks { display: none; } .omd-navcta { margin-left: auto; } }

      /* ── Buttons ── */
      .omd-btn { -webkit-appearance: none; appearance: none; display: inline-flex; align-items: center; justify-content: center; gap: 9px; padding: 16px 26px; border-radius: 14px; border: 2px solid var(--ink); cursor: pointer; font-family: 'Hanken Grotesk', sans-serif; font-weight: 700; font-size: 15.5px; text-decoration: none; transition: transform .16s, background-color .18s, color .18s, box-shadow .18s; }
      .omd-btn-primary { background: var(--orange); border-color: var(--orange); color: #fff; box-shadow: 0 10px 26px rgba(30,95,224,.32); }
      .omd-btn-primary:hover:not(:disabled) { background: #1749C0; border-color: #1749C0; }
      .omd-btn-primary:disabled { opacity: .75; cursor: not-allowed; }
      .omd-btn-ghost { background: transparent; color: var(--ink); }
      .omd-btn-ghost:hover { background: var(--ink); color: #fff; }
      /* Guarantee solid fills against any UA/preflight cascade quirk */
      .omd .omd-btn-primary { background-color: var(--orange) !important; color: #fff !important; }
      .omd .omd-btn-primary:hover:not(:disabled) { background-color: #1749C0 !important; }
      .omd .omd-navcta { background-color: var(--ink) !important; color: #fff !important; }
      .omd .omd-navcta:hover { background-color: var(--orange) !important; }

      /* ── Hero ── */
      .omd-hero { max-width: 1280px; margin: 0 auto; padding: 40px 28px 60px; display: grid; grid-template-columns: 1.05fr .95fr; gap: 56px; align-items: center; }
      @media (max-width: 940px) { .omd-hero { grid-template-columns: 1fr; gap: 44px; } }
      .omd-eyebrow { display: inline-flex; align-items: center; gap: 9px; font-family: 'Space Mono', monospace; font-size: 12px; text-transform: uppercase; letter-spacing: .1em; color: var(--ink2); }
      .omd-h1 { margin: 22px 0 0; font-family: 'Bricolage Grotesque', sans-serif; font-weight: 800; letter-spacing: -.03em; line-height: .94; font-size: clamp(52px, 8vw, 104px); color: var(--ink); }
      .omd-sub { margin-top: 24px; max-width: 500px; font-size: 18px; line-height: 1.55; color: var(--ink2); font-weight: 500; }
      .omd-cta-row { display: flex; align-items: center; gap: 14px; margin-top: 32px; flex-wrap: wrap; }

      /* ── Rotating word: grid-stacked so width never changes, crossfade so no flicker ── */
      .omd-rot { display: inline-grid; vertical-align: baseline; }
      .omd-rot-word { grid-area: 1 / 1; white-space: nowrap; color: var(--orange); opacity: 0; transform: translateY(0.14em); transition: opacity .45s ease, transform .5s cubic-bezier(0.22,1,0.36,1); }
      .omd-rot-word.on { opacity: 1; transform: none; }

      /* ── Hero right / mockup ── */
      .omd-hero-right { display: flex; justify-content: center; }
      .omd-mock { position: relative; width: 100%; max-width: 460px; }
      .omd-mock-win { position: relative; z-index: 1; background: #fff; border: 2px solid var(--ink); border-radius: 20px; overflow: hidden; box-shadow: 14px 14px 0 rgba(20,32,43,.9); animation: omd-float 7s ease-in-out infinite; }
      @keyframes omd-float { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
      .omd-mock-topbar { display: flex; align-items: center; gap: 6px; padding: 12px 15px; border-bottom: 2px solid var(--ink); background: var(--panel); }
      .omd-tb-dot { width: 10px; height: 10px; border-radius: 50%; border: 1.5px solid var(--ink); }
      .omd-tb-dot:nth-child(1) { background: var(--orange); } .omd-tb-dot:nth-child(2) { background: #FFC93C; } .omd-tb-dot:nth-child(3) { background: #12C7A6; }
      .omd-mock-title { margin-left: 8px; font-family: 'Bricolage Grotesque', sans-serif; font-weight: 700; font-size: 13px; color: var(--ink); }
      .omd-mock-live { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; font-family: 'Space Mono', monospace; font-size: 10.5px; text-transform: uppercase; color: var(--ink2); }
      .omd-mock-body { padding: 15px; }
      .omd-mock-stats { display: grid; grid-template-columns: 1fr 1fr 1.4fr; gap: 9px; }
      .omd-mock-tile { border: 1.5px solid var(--line); border-radius: 12px; padding: 11px; }
      .omd-mock-ic { display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 7px; color: #fff; }
      .omd-mock-ic.orange { background: var(--orange); } .omd-mock-ic.blue { background: var(--blue); }
      .omd-mock-tile b { display: block; font-family: 'Bricolage Grotesque', sans-serif; font-weight: 800; font-size: 24px; color: var(--ink); margin-top: 7px; line-height: 1; }
      .omd-mock-tile em { font-style: normal; font-family: 'Space Mono', monospace; font-size: 9.5px; text-transform: uppercase; color: var(--ink3); }
      .omd-mock-chart { border: 1.5px solid var(--line); border-radius: 12px; padding: 11px; display: flex; flex-direction: column; }
      .omd-mock-chart-l { font-family: 'Space Mono', monospace; font-size: 9.5px; text-transform: uppercase; color: var(--ink3); }
      .omd-mock-bars { display: flex; align-items: flex-end; gap: 4px; height: 44px; margin-top: auto; }
      .omd-bar { flex: 1; background: var(--orange); border-radius: 3px 3px 0 0; transform-origin: bottom; animation: omd-bar .7s cubic-bezier(0.34,1.45,0.64,1) both; }
      .omd-bar:nth-child(6) { background: var(--ink); }
      @keyframes omd-bar { 0% { transform: scaleY(0); } 100% { transform: scaleY(1); } }
      .omd-mock-list { margin-top: 11px; display: flex; flex-direction: column; gap: 7px; }
      .omd-mock-card { display: flex; align-items: center; gap: 10px; padding: 9px; border: 1.5px solid var(--line); border-radius: 11px; transition: border-color .3s, background-color .3s; }
      .omd-mock-card.ok { border-color: var(--orange); background: var(--orange-soft); }
      .omd-mock-thumb { width: 36px; height: 36px; border-radius: 8px; flex-shrink: 0; }
      .omd-mock-txt { flex: 1; min-width: 0; }
      .omd-mock-txt b { display: block; font-size: 12.5px; font-weight: 700; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .omd-mock-txt em { font-style: normal; font-family: 'Space Mono', monospace; font-size: 10px; text-transform: uppercase; color: var(--ink3); }
      .omd-mock-status { flex-shrink: 0; display: inline-flex; align-items: center; gap: 4px; font-family: 'Space Mono', monospace; font-size: 10px; text-transform: uppercase; padding: 5px 9px; border-radius: 999px; background: var(--panel); color: var(--ink2); }
      .omd-mock-status.ok { background: var(--orange); color: #fff; animation: omd-pop .4s cubic-bezier(0.34,1.6,0.64,1); }
      @keyframes omd-pop { 0% { transform: scale(.6); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
      .omd-mock-phone { position: absolute; z-index: 2; bottom: -24px; left: -30px; width: 112px; background: var(--ink); border: 2px solid var(--ink); border-radius: 16px; padding: 6px; box-shadow: 10px 10px 0 rgba(30,95,224,.9); animation: omd-float 6s ease-in-out infinite 1s; }
      .omd-mock-reel { position: relative; height: 146px; border-radius: 11px; background: var(--orange); display: grid; place-items: center; overflow: hidden; }
      .omd-mock-play { width: 32px; height: 32px; border-radius: 50%; background: rgba(255,255,255,.3); display: grid; place-items: center; }
      .omd-mock-reeltag { position: absolute; top: 7px; left: 7px; font-family: 'Space Mono', monospace; font-size: 7.5px; letter-spacing: .1em; color: #fff; background: rgba(0,0,0,.35); padding: 2px 5px; border-radius: 4px; }
      .omd-mock-reelbar { display: flex; align-items: center; justify-content: space-between; padding: 6px 3px 2px; }
      .omd-mock-like { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 700; color: #fff; }
      .omd-mock-appr { display: inline-grid; place-items: center; width: 17px; height: 17px; border-radius: 50%; background: #12C7A6; color: #fff; }
      @media (max-width: 460px) { .omd-mock-phone { display: none; } }

      /* ── Value band (bold blue) ── */
      .omd-valueband { background: var(--orange); }
      .omd-value { max-width: 1280px; margin: 0 auto; padding: 84px 28px; }
      .omd-value-head { max-width: 820px; }
      .omd-eyebrow { font-family: 'Space Mono', monospace; font-size: 12px; text-transform: uppercase; letter-spacing: .14em; color: rgba(255,255,255,0.72); }
      .omd-value-title { margin-top: 14px; font-family: 'Bricolage Grotesque', sans-serif; font-weight: 800; font-size: clamp(32px, 4.4vw, 58px); line-height: 1.0; letter-spacing: -.03em; color: #fff; }
      .omd-value-grid { margin-top: 52px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; }
      @media (max-width: 820px) { .omd-value-grid { grid-template-columns: 1fr; gap: 22px; } }
      .omd-value-card { background: #fff; border: 2px solid var(--ink); border-radius: 16px; padding: 26px 24px 28px; box-shadow: 8px 8px 0 var(--ink); transition: transform .18s ease, box-shadow .18s ease; }
      .omd-value-card:hover { transform: translate(-2px, -2px); box-shadow: 12px 12px 0 var(--ink); }
      .omd-value-ic { width: 50px; height: 50px; display: grid; place-items: center; border-radius: 13px; background: var(--orange); color: #fff; }
      .omd-value-ct { margin-top: 20px; font-family: 'Bricolage Grotesque', sans-serif; font-weight: 700; font-size: 23px; letter-spacing: -.01em; color: var(--ink); }
      .omd-value-cd { margin-top: 9px; font-size: 15px; line-height: 1.56; color: var(--ink2); }

      /* ── Kicker + h2 ── */
      .omd-kicker { font-family: 'Space Mono', monospace; font-size: 12px; text-transform: uppercase; letter-spacing: .14em; color: var(--orange); }
      .omd-kicker.light { color: var(--orange); }
      .omd-h2 { font-family: 'Bricolage Grotesque', sans-serif; font-weight: 800; font-size: clamp(32px, 4.6vw, 58px); letter-spacing: -.03em; line-height: 1; margin-top: 12px; color: var(--ink); }
      .omd-h2.light { color: #fff; }

      /* ── Auth band ── */
      .omd-authband { max-width: 1280px; margin: 0 auto; padding: 20px 28px 80px; display: grid; grid-template-columns: 1fr 440px; gap: 56px; align-items: center; }
      @media (max-width: 940px) { .omd-authband { grid-template-columns: 1fr; gap: 36px; } }
      .omd-perks { list-style: none; padding: 0; margin: 26px 0 0; display: flex; flex-direction: column; gap: 14px; }
      .omd-perks li { display: flex; align-items: center; gap: 12px; font-size: 16px; font-weight: 600; color: var(--ink2); }
      .omd-perk-ic { flex-shrink: 0; width: 24px; height: 24px; border-radius: 7px; display: grid; place-items: center; color: #fff; background: var(--orange); }
      .omd-note { margin-top: 26px; font-family: 'Space Mono', monospace; font-size: 12.5px; color: var(--ink3); }
      .omd-note a { color: var(--orange); font-weight: 700; text-decoration: none; }
      .omd-note a:hover { text-decoration: underline; }
      .omd-cardwrap { display: flex; justify-content: center; }
      .omd-card { width: 100%; max-width: 440px; background: #fff; border: 2px solid var(--ink); border-radius: 20px; padding: 30px 28px; box-shadow: 14px 14px 0 rgba(30,95,224,.9); }
      .omd-card-head h3 { font-family: 'Bricolage Grotesque', sans-serif; font-weight: 800; font-size: 26px; color: var(--ink); }
      .omd-card-head p { margin-top: 5px; font-size: 14.5px; color: var(--ink2); }
      .omd-seg { display: flex; gap: 4px; padding: 4px; border: 1.5px solid var(--line); border-radius: 12px; margin: 18px 0; }
      .omd-seg-btn { flex: 1; text-align: center; padding: 9px; border-radius: 9px; font-family: 'Space Mono', monospace; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; color: var(--ink2); cursor: pointer; text-decoration: none; transition: all .16s; }
      .omd-seg-btn.active { background: var(--ink); color: #fff; }
      .omd-seg-btn:not(.active):hover { color: var(--ink); }
      .omd-form { display: flex; flex-direction: column; gap: 16px; }
      .omd-field { display: flex; flex-direction: column; gap: 7px; }
      .omd-field > label { font-family: 'Space Mono', monospace; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: var(--ink2); }
      .omd-input-wrap { position: relative; }
      .omd-input-ic { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); color: var(--ink3); pointer-events: none; }
      .omd-input { width: 100%; height: 52px; padding: 0 44px 0 42px; border: 1.5px solid var(--line); border-radius: 13px; background: #fff; font-family: 'Hanken Grotesk', sans-serif; font-size: 15px; font-weight: 500; color: var(--ink); outline: none; transition: border-color .15s, box-shadow .15s; }
      .omd-input::placeholder { color: #AEBAC6; font-weight: 500; }
      .omd-input:hover:not(:focus) { border-color: var(--ink3); }
      .omd-input:focus { border-color: var(--orange); box-shadow: 0 0 0 3px rgba(30,95,224,.16); }
      .omd-input-wrap:focus-within .omd-input-ic { color: var(--orange); }
      .omd-input.err { border-color: #E5484D; box-shadow: 0 0 0 3px rgba(229,72,77,.14); }
      .omd-input-ok { position: absolute; right: 14px; top: 50%; transform: translateY(-50%); color: var(--orange); pointer-events: none; }
      .omd-eye { -webkit-appearance: none; appearance: none; position: absolute; right: 8px; top: 50%; transform: translateY(-50%); background: none; border: 0; padding: 6px; cursor: pointer; color: var(--ink3); display: grid; place-items: center; border-radius: 8px; transition: color .15s; }
      .omd-eye:hover { color: var(--ink); }
      .omd-field-err { display: flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; color: #C4292F; }
      .omd-row { display: flex; align-items: center; justify-content: space-between; font-size: 13px; margin-top: 2px; }
      .omd-remember { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; color: var(--ink2); cursor: pointer; }
      .omd-remember input { width: 16px; height: 16px; accent-color: var(--orange); }
      .omd-link { background: none; border: 0; cursor: pointer; font-weight: 700; color: var(--orange); font-size: 13px; }
      .omd-link:hover { text-decoration: underline; }
      .omd-err { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-radius: 10px; background: #FDEBEC; border: 1.5px solid rgba(229,72,77,.3); color: #C4292F; font-size: 12.5px; font-weight: 600; }
      .omd-submit { width: 100%; margin-top: 2px; }
      .omd-fineprint { margin-top: 16px; text-align: center; font-family: 'Space Mono', monospace; font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink3); }

      /* ── How it works (dark) ── */
      .omd-how { background: var(--dark); padding: 80px 28px; }
      .omd-how-head { max-width: 1280px; margin: 0 auto; }
      .omd-steps { max-width: 1280px; margin: 44px auto 0; display: grid; grid-template-columns: repeat(3, 1fr); gap: 22px; }
      @media (max-width: 820px) { .omd-steps { grid-template-columns: 1fr; } }
      .omd-step { border: 1.5px solid rgba(255,255,255,.14); border-radius: 18px; padding: 28px; transition: transform .28s cubic-bezier(0.34,1.45,0.64,1), border-color .28s, background-color .28s; }
      .omd-step:hover { transform: translateY(-5px); border-color: var(--orange); background: rgba(30,95,224,.06); }
      .omd-step-num { display: inline-block; font-family: 'Bricolage Grotesque', sans-serif; font-weight: 800; font-size: 44px; color: var(--orange); letter-spacing: -.03em; }
      .omd-step h3 { margin-top: 14px; font-family: 'Bricolage Grotesque', sans-serif; font-weight: 700; font-size: 21px; color: #fff; }
      .omd-step p { margin-top: 8px; font-size: 14.5px; line-height: 1.55; color: #97A7B4; }

      /* ── Quote ── */
      .omd-quote { max-width: 900px; margin: 0 auto; padding: 80px 28px; text-align: center; }
      .omd-quote p { font-family: 'Bricolage Grotesque', sans-serif; font-weight: 600; font-size: clamp(24px, 3.4vw, 40px); line-height: 1.22; letter-spacing: -.02em; color: var(--ink); }
      .omd-quote-by { display: inline-flex; align-items: center; gap: 12px; margin-top: 28px; }
      .omd-avatar { width: 46px; height: 46px; border-radius: 50%; display: grid; place-items: center; font-family: 'Bricolage Grotesque', sans-serif; font-weight: 800; font-size: 15px; color: #fff; background: var(--orange); }
      .omd-quote-by b { display: block; font-size: 14.5px; font-weight: 800; color: var(--ink); text-align: left; }
      .omd-quote-by em { font-style: normal; font-family: 'Space Mono', monospace; font-size: 11px; text-transform: uppercase; color: var(--ink3); }

      /* ── Hover-fill nav ── */
      .omd-fillnav { width: 100%; display: grid; grid-template-columns: repeat(3, 1fr); border-top: 2px solid var(--ink); }
      .omd-fillcell { position: relative; overflow: hidden; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 34px 28px; border-right: 2px solid var(--ink); border-bottom: 2px solid var(--ink); text-decoration: none; }
      .omd-fillcell:last-child { border-right: 0; }
      .omd-fillcell .fill { position: absolute; inset: 0; z-index: 0; background: var(--orange); transform: translateY(101%); transition: transform .42s cubic-bezier(0.76,0,0.24,1); }
      .omd-fillcell:hover .fill, .omd-fillcell:focus-visible .fill { transform: translateY(0); }
      .omd-fillcell .lbl { position: relative; z-index: 1; font-family: 'Bricolage Grotesque', sans-serif; font-weight: 700; letter-spacing: -.02em; font-size: clamp(22px, 3vw, 38px); color: var(--ink); transition: color .34s; }
      .omd-fillcell .arw { position: relative; z-index: 1; color: var(--orange); transition: color .34s, transform .34s cubic-bezier(0.34,1.45,0.64,1); }
      .omd-fillcell:hover .lbl, .omd-fillcell:focus-visible .lbl { color: #fff; }
      .omd-fillcell:hover .arw, .omd-fillcell:focus-visible .arw { color: #fff; transform: translate(5px,-5px); }
      @media (max-width: 720px) { .omd-fillnav { grid-template-columns: 1fr; } .omd-fillcell { border-right: 0; } }

      /* ── Giant wordmark (lives in the dark footer) ── */
      .omd-wm-block { position: relative; width: 100%; margin: 0; padding: 8px 26px 14px; overflow: hidden; }
      .omd-wm-dots {
        position: absolute; inset: 0; z-index: 0; pointer-events: none; opacity: 0; transition: opacity .25s ease;
        background-image: radial-gradient(rgba(140,175,255,.55) 1.5px, transparent 1.8px);
        background-size: 17px 17px;
        -webkit-mask-image: radial-gradient(circle 140px at var(--mx, 50%) var(--my, 50%), #000 0%, rgba(0,0,0,.35) 48%, transparent 74%);
        mask-image: radial-gradient(circle 140px at var(--mx, 50%) var(--my, 50%), #000 0%, rgba(0,0,0,.35) 48%, transparent 74%);
      }
      .omd-wm-dots.on { opacity: 1; }
      .omd-wm { position: relative; z-index: 1; display: flex; justify-content: space-between; align-items: flex-end; flex-wrap: nowrap; line-height: .8; cursor: default; }
      .omd-wm-l { display: inline-block; font-family: 'Bricolage Grotesque', sans-serif; font-weight: 800; letter-spacing: -.045em; color: #FFFFFF; transform-origin: center bottom; font-size: clamp(40px, 14vw, 220px); will-change: transform; }
      .omd-wm-l.accent { color: var(--orange); }

      /* ── Footer (dark, redesigned) ── */
      .omd-footer { position: relative; background: var(--dark); color: #C6D2DC; padding: 44px 0 22px; overflow: hidden; }
      .omd-footer::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 3px; background: linear-gradient(90deg, transparent, var(--orange) 30%, #3B77E8 70%, transparent); opacity: .7; }
      .omd-footer::after { content: ""; position: absolute; inset: 0; z-index: 0; pointer-events: none; background: radial-gradient(680px 240px at 50% 4%, rgba(30,95,224,.20), transparent 68%); }
      .omd-footer .omd-wm-block { position: relative; z-index: 1; }
      .omd-foot-base { position: relative; z-index: 1; width: 100%; margin: 12px 0 0; padding: 18px 30px 0; border-top: 1px solid rgba(255,255,255,.08); display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; font-family: 'Space Mono', monospace; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #7B8A96; }
      .omd-foot-cta { max-width: 1280px; margin: 0 auto; padding: 76px 28px 44px; border-bottom: 1px solid rgba(255,255,255,.1); }
      .omd-foot-h { font-family: 'Bricolage Grotesque', sans-serif; font-weight: 800; font-size: clamp(38px, 6.4vw, 88px); line-height: .95; letter-spacing: -.03em; color: #fff; margin: 14px 0 30px; }
      .omd-foot-grid { max-width: 1280px; margin: 0 auto; padding: 44px 28px; display: flex; justify-content: space-between; gap: 48px; flex-wrap: wrap; }
      .omd-foot-brand { max-width: 340px; }
      .omd-foot-logo { height: 34px; width: auto; display: block; }
      .omd-foot-brand p { margin-top: 16px; font-size: 14.5px; line-height: 1.6; color: #8FA0AD; }
      .omd-footer-cols { display: flex; gap: 46px; flex-wrap: wrap; }
      .omd-footer-cols > div { display: flex; flex-direction: column; gap: 9px; }
      .omd-footer-cols p { font-family: 'Space Mono', monospace; font-size: 10.5px; text-transform: uppercase; letter-spacing: .14em; color: #6C7C88; margin-bottom: 3px; }
      .omd-footer-cols a { font-size: 14.5px; font-weight: 600; color: #C6D2DC; text-decoration: none; transition: color .15s; width: fit-content; }
      .omd-footer-cols a:hover { color: var(--orange); }
      .omd-footer-meta { max-width: 1280px; margin: 0 auto; padding: 20px 28px 36px; display: flex; justify-content: space-between; align-items: center; gap: 14px; flex-wrap: wrap; font-family: 'Space Mono', monospace; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #7B8A96; border-top: 1px solid rgba(255,255,255,.09); }
      .omd-footer-online { display: inline-flex; align-items: center; gap: 8px; }
      .omd-totop { -webkit-appearance: none; appearance: none; background: none; border: 0; cursor: pointer; font-family: 'Space Mono', monospace; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #C6D2DC; display: inline-flex; align-items: center; gap: 6px; transition: color .15s; }
      .omd-totop:hover { color: var(--orange); }

      /* ── Reveal ── */
      .omd .reveal { opacity: 0; transform: translateY(26px); transition: opacity .7s cubic-bezier(0.22,1,0.36,1), transform .7s cubic-bezier(0.22,1,0.36,1); }
      .omd .reveal.in { opacity: 1; transform: none; }

      /* Value-band "lift up" rise — default is VISIBLE; JS arms it (opacity 0) then reveals on scroll */
      .omd .omd-rev { opacity: 1; transform: none; }
      .omd .omd-rev.omd-armed { opacity: 0; transform: translateY(80px) scale(.96); will-change: transform, opacity; }
      .omd .omd-rev.omd-armed.omd-inview { opacity: 1; transform: none; transition: opacity .8s cubic-bezier(0.16,1,0.3,1), transform .9s cubic-bezier(0.16,1,0.3,1); }

      /* ── Modal ── */
      .omd-modal-overlay { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 16px; background: rgba(14,22,32,.55); backdrop-filter: blur(4px); }
      .omd-modal { position: relative; width: 100%; max-width: 380px; background: #fff; border: 2px solid var(--ink); border-radius: 20px; padding: 28px; box-shadow: 12px 12px 0 rgba(30,95,224,.9); }
      .omd-modal-x { position: absolute; top: 16px; right: 16px; background: none; border: 0; cursor: pointer; color: var(--ink3); }
      .omd-modal-x:hover { color: var(--ink); }
      .omd-modal h3 { font-family: 'Bricolage Grotesque', sans-serif; font-weight: 800; font-size: 22px; color: var(--ink); }
      .omd-modal-p { margin-top: 10px; font-size: 13.5px; line-height: 1.5; color: var(--ink2); }
      .omd-modal-form { display: flex; flex-direction: column; gap: 14px; margin-top: 16px; }
      .omd-modal-input { width: 100%; padding: 13px 15px; border: 1.5px solid var(--line); border-radius: 12px; font-size: 14px; color: var(--ink); background: #fff; outline: none; transition: border-color .15s, box-shadow .15s; }
      .omd-modal-input:focus { border-color: var(--orange); box-shadow: 0 0 0 3px rgba(30,95,224,.18); }
      .omd-modal-err { font-size: 12.5px; font-weight: 600; color: #C4292F; }

      /* ── Kill the custom cursor + poke-dots on touch / no-hover devices ── */
      @media (hover: none), (pointer: coarse) {
        .omd > .omd-cursor, .omd > .omd-cursor-ring, .omd-wm-dots { display: none !important; }
      }

      /* ── Mobile refinements ── */
      @media (max-width: 640px) {
        .omd-nav-inner { padding: 13px 18px; height: 64px; }
        .omd-navcta { padding: 10px 16px; font-size: 13px; }

        .omd-hero { padding: 26px 20px 44px; gap: 34px; }
        .omd-h1 { margin-top: 16px; font-size: clamp(36px, 11.5vw, 50px); line-height: .96; }
        .omd-sub { margin-top: 18px; font-size: 16px; }
        .omd-cta-row { margin-top: 24px; gap: 10px; }
        .omd-cta-row .omd-btn { flex: 1 1 auto; }

        .omd-value { padding: 52px 20px; }
        .omd-value-title { font-size: clamp(28px, 8.5vw, 38px); }
        .omd-value-title br { display: none; }
        .omd-value-grid { margin-top: 34px; }
        .omd-value-card { padding: 22px 20px 24px; box-shadow: 6px 6px 0 var(--ink); }

        .omd-authband { padding: 12px 20px 60px; gap: 30px; }
        .omd-how { padding: 56px 20px; }
        .omd-quote { padding: 56px 20px; }

        .omd-fillcell { padding: 24px 20px; }
        .omd-footer-meta { padding: 18px 20px 30px; }
      }

      @media (prefers-reduced-motion: reduce) {
        .omd-live, .omd-mock-win, .omd-mock-phone, .omd-bar, .omd-rot-word { animation: none !important; }
        .omd .reveal { opacity: 1; transform: none; }
        .omd > .omd-cursor, .omd > .omd-cursor-ring, .omd-wm-dots { display: none !important; }
      }
    `}</style>
  );
}
