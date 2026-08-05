"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { apiFetch } from "@/lib/api";
import { jobSlug } from "@/lib/slug";
import { smoothScrollToId } from "@/lib/scroll";
import HeroLoader from "@/components/HeroLoader";
import { HeroBackdrop, useHeroFX } from "@/components/HeroCanvas";
import RoleRow from "@/components/RoleRow";

// The loader must play once per real page load (first visit / refresh) and NEVER on a
// client-side navigation back to "/".
//
// This flag lives on `window`, deliberately NOT at module scope. A module-level variable
// resets whenever the module is first evaluated — and if the visitor lands directly on a
// role page (a shared job link), this module hasn't loaded yet, so navigating back to "/"
// evaluates it fresh with the flag false and the loader replays. `window` is created once
// per document: it survives every soft navigation but resets on a genuine reload, which
// is exactly the lifetime we want. Not sessionStorage — that would persist across
// refreshes and suppress the loader when it should play.
declare global {
  interface Window {
    __dsJobsLoaderPlayed?: boolean;
    /** Set by an inline script in layout.tsx, once per document, before hydration. */
    __dsEntryPath?: string;
  }
}

function shouldShowLoader(): boolean {
  // Server render: this component only renders for "/", so the prerendered HTML always
  // includes the loader. The client's first render on a real "/" load agrees, so there's
  // no hydration mismatch. Soft navigations render client-only, with no HTML to match.
  if (typeof window === "undefined") return true;
  if (window.__dsJobsLoaderPlayed) return false;
  return window.__dsEntryPath === "/";
}

interface ApiJob {
  id: string;
  title: string;
  department?: string;
  location?: string;
  type: string;
  experience?: string;
  salary?: string;
  description: string;
  requirements?: string;
  responsibilities?: string;
  benefits?: string;
  createdAt?: string;
  _count?: { applications: number };
}

const TYPE_DISPLAY: Record<string, string> = {
  FULL_TIME: "Full-time",
  PART_TIME: "Part-time",
  CONTRACT: "Contract",
  INTERNSHIP: "Internship",
  FREELANCE: "Freelance",
};

// Map the internal filter state to a clean URL value and back, so a filtered view
// is a shareable link (e.g. ?type=internship) that survives refresh and browser-back.
const FILTER_TO_PARAM: Record<string, string> = {
  all: "",
  "Full-time": "full-time",
  Internship: "internship",
  Contract: "contract",
};
const PARAM_TO_FILTER: Record<string, string> = {
  "full-time": "Full-time",
  internship: "Internship",
  contract: "Contract",
};

// `initialJobs` is fetched on the server (see page.tsx) and seeded into SWR's cache
// so the FIRST render — the one Googlebot indexes — already contains every job as
// real HTML. SWR then revalidates in the background for live data on the client.
//
// This page is now a pure LIST: each row links through to the role's own page
// (/[slug]), which carries the full detail view + application form. There is no
// longer an inline detail panel or apply modal here.
export default function JobsPage({ initialJobs = [] }: { initialJobs?: ApiJob[] }) {
  const router = useRouter();
  const heroRef = useRef<HTMLElement>(null);
  // Background motion (grid pan, floating "noise" text, antigravity dots, and the cube
  // canvas's own rAF-driven entrance) stays paused until the loader is gone — otherwise
  // those animations play out entirely hidden behind the loader and the hero appears
  // frozen/already-settled the moment it reveals. If the loader already played once
  // this page load, skip straight to "running" instead of waiting on a loader that
  // won't render.
  const [showLoader] = useState(shouldShowLoader);
  const [heroPlaying, setHeroPlaying] = useState(() => !shouldShowLoader());
  const fx = useHeroFX(heroRef, heroPlaying);

  // Mark it played as soon as it mounts, not on completion — so navigating away
  // mid-animation and returning still doesn't replay it.
  useEffect(() => {
    if (showLoader) window.__dsJobsLoaderPlayed = true;
  }, [showLoader]);
  const { data, isLoading } = useSWR(
    "/jobs",
    (url: string) => apiFetch<any>(url),
    { fallbackData: { success: true, data: initialJobs } },
  );

  // Memoize so the array reference is stable — prevents useEffect re-firing every render.
  const jobs: ApiJob[] = useMemo(() => data?.data ?? [], [data]);

  // True only on a genuine cold load (no server-seeded jobs yet). Because the server
  // seeds `initialJobs` into SWR's fallbackData, the prerendered HTML has jobs and
  // `coldLoad` is false — so crawlers see real content, never "Loading…" placeholders.
  const coldLoad = isLoading && jobs.length === 0;

  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  // Read-only hint of which roles the visitor already applied to (persisted by the
  // application form on the role page). Drives the "Applied" pill only.
  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set());

  const searchRef = useRef<HTMLInputElement>(null);

  // Load applied ids from localStorage (client-side hint only — server has the real state).
  useEffect(() => {
    try {
      const raw = localStorage.getItem("ds-careers-v1");
      if (raw) {
        const s = JSON.parse(raw);
        setAppliedIds(new Set(s.applied || []));
      }
    } catch {
      // Ignore malformed/unavailable localStorage — the pill is a best-effort hint.
    }
  }, []);

  // Keyboard shortcut: ⌘/Ctrl-K focuses search.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Seed filter + search from the URL on load, so a shared/refreshed/back-navigated
  // link like ?type=internship&q=editor restores the same view. Read from
  // window.location (not useSearchParams) so the page stays server-rendered for SEO
  // and needs no Suspense boundary.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const t = sp.get("type");
    const q = sp.get("q");
    if (t && PARAM_TO_FILTER[t]) setFilter(PARAM_TO_FILTER[t]);
    if (q) setSearch(q);
  }, []);

  // Reflect the current filter/search back into the URL. replaceState (not push)
  // keeps history clean — no entry per keystroke — while still making the URL
  // copy-shareable and restoring on refresh/back. The first run is skipped so it
  // can't clobber the incoming params before the seed effect above applies them.
  const didFirstSync = useRef(false);
  useEffect(() => {
    if (!didFirstSync.current) {
      didFirstSync.current = true;
      return;
    }
    const sp = new URLSearchParams();
    const typeParam = FILTER_TO_PARAM[filter];
    if (typeParam) sp.set("type", typeParam);
    const q = search.trim();
    if (q) sp.set("q", q);
    const qs = sp.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, [filter, search]);

  // Filter logic
  const filterApiType: Record<string, string> = {
    "Full-time": "FULL_TIME",
    "Internship": "INTERNSHIP",
    "Contract": "CONTRACT",
  };

  const visibleJobs = jobs.filter((j) => {
    if (filter !== "all" && j.type !== filterApiType[filter]) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        j.title.toLowerCase().includes(q) ||
        (j.department || "").toLowerCase().includes(q) ||
        (j.location || "").toLowerCase().includes(q) ||
        (TYPE_DISPLAY[j.type] || "").toLowerCase().includes(q)
      );
    }
    return true;
  });

  const ftCount = jobs.filter((j) => j.type === "FULL_TIME").length;
  const internCount = jobs.filter((j) => j.type === "INTERNSHIP").length;
  const contractCount = jobs.filter((j) => j.type === "CONTRACT").length;

  // Navigate to a role's own page (the detail + apply experience).
  function openJob(job: ApiJob) {
    router.push(`/${jobSlug(job)}`);
  }

  return (
    <>
      {showLoader && (
        <HeroLoader
          onDone={() => {
            setHeroPlaying(true);
          }}
        />
      )}

      {/* ───── HERO ───── */}
      <section className="ds-hero" ref={heroRef} data-hero-play={heroPlaying ? "running" : "paused"}>
        <HeroBackdrop trailCanvasRef={fx.trailCanvasRef} />

        <div className="ds-hero-inner">
          <div className="ds-hero-canvas-wrap" aria-hidden="true">
            <canvas ref={fx.cubeCanvasRef} />
          </div>

          <h1 className="ds-hero-headline">
            <span style={{ animationDelay: ".1s" }}>We&apos;re building a workplace</span>
            <span style={{ animationDelay: ".32s" }}>that feels less like a scramble</span>
            <em style={{ animationDelay: ".56s" }}>and more like a plan.</em>
          </h1>

          <svg className="ds-hero-underline" viewBox="0 0 460 26" fill="none" aria-hidden="true">
            <path d="M6 15 C 120 4, 330 2, 454 9" strokeWidth={2.4} strokeLinecap="round" />
            <path d="M24 19 C 150 26, 300 8, 436 17" strokeWidth={1.4} strokeLinecap="round" />
          </svg>

          <p className="ds-hero-lede">
            Digital Sukoon is a full-service digital marketing studio in Mumbai, building
            campaigns for brands since 2015. We&apos;re growing the team across multiple
            disciplines — full-time, internship, and contract.
          </p>

          <div className="ds-hero-ctas">
            <a
              className="ds-btn primary"
              href="#index"
              onClick={(e) => { e.preventDefault(); smoothScrollToId("index"); }}
            >
              See open roles
              <span className="arrow">→</span>
            </a>
            <a className="ds-btn glass" href="https://digitalsukoon.com" target="_blank" rel="noopener noreferrer">
              Visit our studio
            </a>
          </div>
        </div>
      </section>

      {/* ───── ROLE INDEX ───── */}
      <section className="ds-index" id="index">
        <div className="ds-index-head">
          <h2 className="ds-index-title">
            Open roles <span className="count">({coldLoad ? "…" : visibleJobs.length})</span>
          </h2>
          <div className="ds-index-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.5" y2="16.5" />
            </svg>
            <input
              ref={searchRef}
              type="text"
              placeholder="Search roles, teams, locations…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoComplete="off"
            />
          </div>
        </div>

        {/* Filter chips — regular toggle buttons, not a tab pattern */}
        <div className="ds-chips">
          {[
            { key: "all", label: "All roles", count: jobs.length },
            { key: "Full-time", label: "Full-time", count: ftCount },
            { key: "Internship", label: "Internship", count: internCount },
            { key: "Contract", label: "Contract", count: contractCount },
          ].map(({ key, label, count }) => (
            <button
              key={key}
              className={filter === key ? "on" : ""}
              onClick={() => setFilter(key)}
              type="button"
              aria-pressed={filter === key}
            >
              {label} <span>{count}</span>
            </button>
          ))}
        </div>

        {/* Full-width role list — each row links to the role's own page */}
        <ol className="ds-roles" style={{ marginTop: 24 }}>
          {coldLoad ? (
            Array.from({ length: 4 }).map((_, i) => (
              <li key={i} style={{ height: 72, borderRadius: 14, background: "rgba(11,15,58,0.04)", marginBottom: 4 }} />
            ))
          ) : visibleJobs.length === 0 ? (
            <li className="ds-roles-empty">
              <img src="/illustrations/no-data.svg" alt="" aria-hidden="true" />
              <div className="msg">No roles match that search — try another word.</div>
            </li>
          ) : (
            visibleJobs.map((job) => (
              <RoleRow
                key={job.id}
                job={job}
                isApplied={appliedIds.has(job.id)}
                onOpen={() => openJob(job)}
              />
            ))
          )}
        </ol>
      </section>

    </>
  );
}
