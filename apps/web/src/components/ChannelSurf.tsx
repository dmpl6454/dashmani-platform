"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, TouchEvent as ReactTouchEvent } from "react";
import {
  CHANNELS,
  CONTACT_EMAIL,
  CASE_STUDIES,
  CONTACT_PHONE,
  LINEUP,
  LOGOS,
  MONTHLY_VIEWS,
  OFFICES,
  PLATFORM_REACH,
  PROPERTY_NAMES,
  SERVICES,
  STEPS,
  TEAM,
  initials,
  instagramEmbedUrl,
} from "@/lib/content";
import ContactForm from "./ContactForm";

const N = CHANNELS.length;
const TILE_MAX = 96;
const VIEWS_PER_SECOND = 3276; // 103.3B views ÷ seconds in a year

const pad2 = (n: number) => String(n).padStart(2, "0");
const istClock = () => new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata" });

function tileCount() {
  const w = window.innerWidth;
  return w < 700 ? 48 : w < 1100 ? 80 : 96;
}

function channelFromHash(): number {
  const slug = window.location.hash.replace(/^#/, "");
  return CHANNELS.findIndex((c) => c.slug === slug);
}

// Primary buttons drift toward the cursor and spring back on leave.
function magnet(e: ReactMouseEvent<HTMLElement>) {
  if (reducedMotion()) return;
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  el.style.transform = `translate(${(e.clientX - r.left - r.width / 2) * 0.18}px,${(e.clientY - r.top - r.height / 2) * 0.28}px)`;
}
function unmagnet(e: ReactMouseEvent<HTMLElement>) {
  e.currentTarget.style.transform = "";
}
function tilt(e: ReactMouseEvent<HTMLElement>) {
  if (reducedMotion()) return;
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width - 0.5;
  const py = (e.clientY - r.top) / r.height - 0.5;
  el.style.transform = `perspective(900px) rotateY(${px * 8}deg) rotateX(${-py * 8}deg) translateY(-4px)`;
}
function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function PlatformReach() {
  return (
    <ul className="platforms" aria-label="Audience by platform">
      {PLATFORM_REACH.map((p) => (
        <li key={p.platform}>
          <strong>{p.value}</strong>
          <span>{p.platform}</span>
        </li>
      ))}
      <li className="platforms-views">
        <strong>{MONTHLY_VIEWS.value}</strong>
        <span>{MONTHLY_VIEWS.label}</span>
      </li>
    </ul>
  );
}

export default function ChannelSurf() {
  const [ch, setCh] = useState(0);
  const [noise, setNoise] = useState(false);
  const [lit, setLit] = useState<Set<number>>(() => new Set());
  const [clock, setClock] = useState("");
  const [live, setLive] = useState(0);
  const [reach, setReach] = useState(400);
  const [cat, setCat] = useState("Entertainment");
  const [open, setOpen] = useState(0);

  const chRef = useRef(0);
  const scrollRef = useRef<HTMLElement | null>(null);
  const timers = useRef<number[]>([]);
  const wheelLock = useRef(false);
  const edgeArmed = useRef(0);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const reachRaf = useRef(0);

  const countReach = useCallback(() => {
    cancelAnimationFrame(reachRaf.current);
    if (reducedMotion()) {
      setReach(400);
      return;
    }
    const t0 = performance.now();
    const f = (t: number) => {
      const p = Math.min(1, (t - t0) / 1400);
      setReach(Math.round(400 * (1 - Math.pow(1 - p, 3))));
      if (p < 1) reachRaf.current = requestAnimationFrame(f);
    };
    reachRaf.current = requestAnimationFrame(f);
  }, []);

  const show = useCallback(
    (n: number) => {
      chRef.current = n;
      setCh(n);
      if (n === 1) countReach();
      const url = `${window.location.pathname}${window.location.search}${n === 0 ? "" : `#${CHANNELS[n].slug}`}`;
      if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
        window.history.replaceState(null, "", url);
      }
    },
    [countReach],
  );

  const go = useCallback(
    (target: number) => {
      const n = (target + N) % N;
      if (n === chRef.current) return;
      chRef.current = n;
      edgeArmed.current = 0;
      timers.current.forEach(clearTimeout);
      if (reducedMotion()) {
        show(n);
        return;
      }
      setNoise(true);
      timers.current = [window.setTimeout(() => show(n), 140), window.setTimeout(() => setNoise(false), 320)];
    },
    [show],
  );

  // Deep link (#reach, #contact…) and back/forward between hashes.
  useEffect(() => {
    const fromHash = () => {
      const n = channelFromHash();
      if (n >= 0 && n !== chRef.current) show(n);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [show]);

  // Clock, live view counter and the tile wall flicker (every 700ms).
  useEffect(() => {
    const t0 = performance.now();
    const still = reducedMotion();
    const tick = () => {
      if (!still) {
        const max = tileCount();
        const next = new Set<number>();
        for (let i = 0; i < 16; i++) next.add(Math.floor(Math.random() * max));
        setLit(next);
      }
      setClock(istClock());
      setLive(Math.floor(((performance.now() - t0) / 1000) * VIEWS_PER_SECOND));
    };
    tick();
    const iv = window.setInterval(tick, 700);
    return () => {
      clearInterval(iv);
      cancelAnimationFrame(reachRaf.current);
      timers.current.forEach(clearTimeout);
    };
  }, []);

  // Keyboard: ↓/→ next, ↑/← previous, 1–6 jump. Ignored while typing in a form field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input,select,textarea")) return;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        go(chRef.current + 1);
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        go(chRef.current - 1);
      } else if (/^[1-6]$/.test(e.key)) {
        go(Number(e.key) - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  // Wheel at a channel's scroll edge: the first tick arms (1.2s), the second changes channel.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (wheelLock.current || Math.abs(e.deltaY) < 25) return;
      const sc = scrollRef.current;
      if (sc) {
        const atTop = sc.scrollTop <= 2;
        const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2;
        if ((e.deltaY > 0 && !atBottom) || (e.deltaY < 0 && !atTop)) {
          edgeArmed.current = 0;
          return;
        }
        const now = performance.now();
        if (sc.scrollHeight > sc.clientHeight + 4 && (!edgeArmed.current || now - edgeArmed.current > 1200)) {
          edgeArmed.current = now;
          return;
        }
      }
      wheelLock.current = true;
      window.setTimeout(() => (wheelLock.current = false), 900);
      go(chRef.current + (e.deltaY > 0 ? 1 : -1));
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => window.removeEventListener("wheel", onWheel);
  }, [go]);

  const onTouchStart = (e: ReactTouchEvent) => {
    const p = e.touches[0];
    touch.current = { x: p.clientX, y: p.clientY };
  };
  const onTouchEnd = (e: ReactTouchEvent) => {
    const start = touch.current;
    touch.current = null;
    if (!start) return;
    const p = e.changedTouches[0];
    const dx = p.clientX - start.x;
    const dy = p.clientY - start.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(chRef.current + (dx < 0 ? 1 : -1));
  };

  const setScroll = (el: HTMLElement | null) => {
    scrollRef.current = el;
  };

  const navButtons = (cls: string) =>
    CHANNELS.map((c, i) => (
      <button
        key={c.slug}
        type="button"
        onClick={() => go(i)}
        aria-current={i === ch ? "page" : undefined}
        className={cls}
      >
        <span className="num">{cls === "tab" ? pad2(i + 1) : `CH ${pad2(i + 1)}`}</span>
        <span className="name">{c.name}</span>
      </button>
    ));

  const ticker = [...PROPERTY_NAMES, ...PROPERTY_NAMES];

  return (
    <div className="shell">
      <header className="header">
        <a
          href="#"
          className="brand"
          aria-label="Digital Sukoon home"
          onClick={(e) => {
            e.preventDefault();
            go(0);
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" width={32} height={32} />
          Digital Sukoon
        </a>
        <span className="on-air">
          <i aria-hidden="true" />
          On air
        </span>
        <span className="ch-count" aria-live="polite">
          CH {pad2(ch + 1)} / 06
        </span>
        <span className="clock" suppressHydrationWarning>
          IST {clock}
        </span>
        <button type="button" className="btn btn-primary" onClick={() => go(5)} onMouseMove={magnet} onMouseLeave={unmagnet}>
          Start a campaign <span aria-hidden="true">→</span>
        </button>
      </header>

      <div className="body">
        <nav aria-label="Channels" className="strip">
          {navButtons("strip-btn")}
        </nav>
        <nav aria-label="Channels" className="rail">
          {navButtons("rail-btn")}
          <p className="rail-help">Scroll, ↑ ↓ or 1–6 to change channel</p>
        </nav>

        <main className="screen" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          <div className="scanlines" aria-hidden="true" />
          <div className={`static${noise ? " on" : ""}`} aria-hidden="true" />
          <div className="edge-hint" aria-hidden="true">
            <span className="desk">{ch < 5 ? `Keep scrolling for CH ${pad2(ch + 2)}` : "Scroll up to rewind"}</span>
            <span className="touch">Swipe ← → to change channel</span>
          </div>

          {ch === 0 && (
            <section key="network" ref={setScroll} className="channel" aria-label="CH 01 Network">
              <div className="net-top">
                <div className="net-intro">
                  <h1 className="h1">
                    We distribute
                    <br />
                    <span className="accent">attention.</span>
                  </h1>
                  <p>
                    Digital Sukoon is a media network and amplification company connecting brands, entertainment and
                    culture with 400M+ audiences across Facebook, Instagram, YouTube and Snapchat. Every tile is a page we
                    own.
                  </p>
                </div>
                <PlatformReach />
                <div className="tiles" aria-hidden="true">
                  {Array.from({ length: TILE_MAX }, (_, i) => (
                    <div key={i} className={`tile${lit.has(i) ? " on" : ""}${i % 17 === 3 ? " hot" : ""}`}>
                      <span>{PROPERTY_NAMES[i % PROPERTY_NAMES.length]}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="lineup">
                <div className="lineup-copy">
                  <p className="kicker">The line-up</p>
                  <h2 className="h2">
                    One network.
                    <br />
                    Billions of impressions.
                  </h2>
                  <p>
                    400+ owned digital IP and assets across entertainment pages, a paparazzi network, a television network,
                    and niche and lifestyle communities.
                  </p>
                  <div className="chips">
                    {Object.keys(LINEUP).map((name) => (
                      <button key={name} type="button" className="chip" aria-pressed={name === cat} onClick={() => setCat(name)}>
                        {name}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="props" aria-live="polite">
                  {LINEUP[cat].map(([name, meta], i) => (
                    <div key={name} className="prop">
                      <span className="n">{pad2(i + 1)}</span>
                      <span className="name">{name}</span>
                      <span className="meta">{meta}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          {ch === 1 && (
            <section key="reach" ref={setScroll} className="channel pad reach" aria-label="CH 02 Reach">
              <p className="kicker">Reach · live</p>
              <p className="reach-count" aria-label="400 million plus audience">
                {reach}M+
              </p>
              <PlatformReach />
              <div className="stats">
                <div>
                  <p className="stat-v">100+</p>
                  <p className="stat-l">Channels · owned pages</p>
                </div>
                <div>
                  <p className="stat-v accent">103B</p>
                  <p className="stat-l" style={{ color: "var(--light)" }}>
                    Views · FY26
                  </p>
                </div>
                <div>
                  <p className="stat-v">30%</p>
                  <p className="stat-l">Celebrity content share</p>
                </div>
                <div>
                  <p className="stat-v">2.5M+</p>
                  <p className="stat-l">Video library</p>
                </div>
              </div>
              <div className="stack-14">
                <p className="kicker">Annual views</p>
                <div className="bars">
                  <div className="bar-col">
                    <span style={{ color: "var(--text-2)" }}>FY24 · 0.9B</span>
                    <div className="bar" style={{ height: "2%", minHeight: 4, background: "var(--text-2)" }} />
                  </div>
                  <div className="bar-col">
                    <span>FY25 · 38.1B · +42x</span>
                    <div className="bar" style={{ height: "37%", background: "#fff", animationDelay: ".15s" }} />
                  </div>
                  <div className="bar-col">
                    <span style={{ color: "var(--light)" }}>FY26 · 103.3B · +2.7x</span>
                    <div
                      className="bar"
                      style={{ height: "100%", background: "linear-gradient(180deg,#403CFA,#0A06BA)", animationDelay: ".3s" }}
                    />
                  </div>
                </div>
                <p className="source">Source: Meta channel analytics exports, Sep 2023 to Sep 2026.</p>
              </div>
              <div className="compare">
                <div>
                  <p className="label" style={{ color: "var(--text-2)" }}>
                    Most agencies
                  </p>
                  <p className="text" style={{ color: "var(--text-2)" }}>
                    Brand → Agency → Media buying → Publisher → Audience. Reach is rented, campaign by campaign.
                  </p>
                </div>
                <div>
                  <p className="label" style={{ color: "var(--light)" }}>
                    Digital Sukoon
                  </p>
                  <p className="text">
                    Brand → Digital Sukoon network → Audience. We own the pages, so audiences compound with every campaign.
                  </p>
                </div>
              </div>
            </section>
          )}

          {ch === 2 && (
            <section key="services" ref={setScroll} className="channel pad services" aria-label="CH 03 Services">
              <div className="head-row">
                <div className="stack-12">
                  <p className="kicker">Programming</p>
                  <h2 className="h2">
                    Built for <span className="accent">distribution.</span>
                  </h2>
                </div>
                <p className="lede">We don&apos;t just run ads. We create momentum. Click a show to see the format list.</p>
              </div>
              <div className="svc-list">
                {SERVICES.map(([title, body, formats], i) => {
                  const isOpen = open === i;
                  return (
                    <div key={title} className={`svc${isOpen ? " open" : ""}`}>
                      <button
                        type="button"
                        className="svc-btn"
                        aria-expanded={isOpen}
                        aria-controls={`svc-${i}`}
                        onClick={() => setOpen(isOpen ? -1 : i)}
                      >
                        <span className="svc-num">{pad2(i + 1)}</span>
                        <span className="svc-title">{title}</span>
                        <span className="svc-body">{body}</span>
                        <span className="svc-sign" aria-hidden="true">
                          {isOpen ? "−" : "+"}
                        </span>
                      </button>
                      {isOpen && (
                        <div id={`svc-${i}`} className="svc-tags">
                          {formats.map((f) => (
                            <span key={f} className="tag">
                              {f}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="stack-14" style={{ paddingTop: 12 }}>
                <p className="kicker">How a campaign airs</p>
                <div className="steps">
                  {STEPS.map((t, i) => (
                    <div key={t}>
                      <span className="n">Step {pad2(i + 1)}</span>
                      <span className="t">{t}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          {ch === 3 && (
            <section key="work" ref={setScroll} className="channel pad work" aria-label="CH 04 Work">
              <div className="stack-12">
                <p className="kicker">Case studies</p>
                <h2 className="h2">
                  Trusted to create
                  <br />
                  <span className="accent">cultural momentum.</span>
                </h2>
              </div>
              <div className="cards cases">
                {CASE_STUDIES.map((c) => {
                  const embed = c.reelUrl ? instagramEmbedUrl(c.reelUrl) : null;
                  return (
                    <article
                      key={c.brand}
                      className={`card${embed ? " has-reel" : ""}`}
                      onMouseMove={embed ? undefined : tilt}
                      onMouseLeave={embed ? undefined : unmagnet}
                    >
                      {embed ? (
                        <div className="card-reel">
                          <iframe
                            src={embed}
                            title={`${c.brand} — top campaign reel on Instagram`}
                            loading="lazy"
                            scrolling="no"
                            allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share"
                            allowFullScreen
                          />
                        </div>
                      ) : (
                        <div className="card-media">
                          <div className="row">
                            <span className="rec">● Rec</span>
                            <span style={{ color: "var(--text-2)" }}>{c.tag}</span>
                          </div>
                          <span style={{ color: "var(--muted)" }}>Campaign media</span>
                        </div>
                      )}
                      <div className="card-body">
                        <p className="name">{c.brand}</p>
                        <p className="kind">{c.campaign}</p>
                        {c.results && c.results.length > 0 && (
                          <dl className="case-results">
                            {c.results.map((r) => (
                              <div key={r.label}>
                                <dt>{r.label}</dt>
                                <dd>{r.value}</dd>
                              </div>
                            ))}
                          </dl>
                        )}
                        {embed && (
                          <a className="case-link" href={c.reelUrl} target="_blank" rel="noopener noreferrer">
                            Top reel · Watch on Instagram <span aria-hidden="true">↗</span>
                          </a>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
              <div className="stack-14">
                <p className="kicker" style={{ color: "var(--text-2)" }}>
                  Brands · studios · production houses · OTT · music labels
                </p>
                <div className="logos">
                  {LOGOS.map((l) => (
                    <div key={l}>{l}</div>
                  ))}
                </div>
              </div>
            </section>
          )}

          {ch === 4 && (
            <section key="studio" ref={setScroll} className="channel pad studio" aria-label="CH 05 Studio">
              <div className="head-row">
                <div className="stack-12">
                  <p className="kicker">Behind the broadcast</p>
                  <h2 className="h2">
                    106 people.
                    <br />
                    <span className="accent">Three cities. Two studios.</span>
                  </h2>
                </div>
                <p className="lede">Tech-first, with in-house content infrastructure across Mumbai, Gurgaon and Bangalore.</p>
              </div>
              <div className="team">
                {TEAM.map(([name, role]) => (
                  <div key={name} className="member">
                    <div className="avatar" aria-hidden="true">
                      {initials(name)}
                    </div>
                    <p className="name">{name}</p>
                    <p className="role">{role}</p>
                  </div>
                ))}
              </div>
              <div className="offices">
                {OFFICES.map((o) => (
                  <address key={o.city}>
                    <span className="city">{o.city}</span>
                    <span>{o.address}</span>
                    <a href={`tel:${o.tel}`}>{o.phone}</a>
                  </address>
                ))}
              </div>
            </section>
          )}

          {ch === 5 && (
            <section key="contact" ref={setScroll} className="channel contact" aria-label="CH 06 Contact">
              <div className="contact-panel">
                <h2 className="h1">
                  Book a slot
                  <br />
                  on our network.
                </h2>
                <div className="lines">
                  <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
                  <a href={`tel:${CONTACT_PHONE.tel}`} style={{ fontWeight: 400 }}>
                    {CONTACT_PHONE.display}
                  </a>
                </div>
              </div>
              <ContactForm onMagnet={magnet} onUnmagnet={unmagnet} />
            </section>
          )}
        </main>
      </div>

      <footer className="footer">
        <span className="live-tag">LIVE</span>
        <div className="ticker" aria-hidden="true">
          <div className="ticker-track">
            {ticker.map((name, i) => (
              <span key={i} className={i % 5 === 0 ? "alt" : undefined}>
                {name}
              </span>
            ))}
          </div>
        </div>
        <span className="views" suppressHydrationWarning>
          {live.toLocaleString("en-IN")} views since you tuned in
        </span>
      </footer>

      <nav aria-label="Channels" className="tabs">
        {navButtons("tab")}
      </nav>
    </div>
  );
}
