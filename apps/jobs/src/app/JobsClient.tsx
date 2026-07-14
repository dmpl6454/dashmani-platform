"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { apiFetch } from "@/lib/api";
import { getDeptColor } from "@/lib/dept-colors";
import { jobSlug } from "@/lib/slug";
import { smoothScrollToId } from "@/lib/scroll";
import ShareButton from "@/components/ShareButton";

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

function timeAgo(dateStr?: string): string {
  if (!dateStr) return "Recently posted";
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  if (days <= 0) return "Posted today";
  if (days === 1) return "Posted yesterday";
  if (days < 7) return `Posted ${days}d ago`;
  if (days < 30) return `Posted ${Math.round(days / 7)}w ago`;
  return `Posted ${Math.round(days / 30)}mo ago`;
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

const NUM_WORDS = ["zero","one","two","three","four","five","six","seven","eight","nine","ten",
  "eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen","twenty"];

function numWord(n: number): string {
  return NUM_WORDS[n] ?? String(n);
}

// `initialJobs` is fetched on the server (see page.tsx) and seeded into SWR's cache
// so the FIRST render — the one Googlebot indexes — already contains every job as
// real HTML. SWR then revalidates in the background for live data on the client.
//
// This page is now a pure LIST: each row links through to the role's own page
// (/[slug]), which carries the full detail view + application form. There is no
// longer an inline detail panel or apply modal here.
export default function JobsPage({ initialJobs = [] }: { initialJobs?: ApiJob[] }) {
  const router = useRouter();
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

  // Index title text
  function indexTitle() {
    const n = visibleJobs.length;
    if (search && filter === "all") {
      if (n === 0) return "No matches.";
      return `${n === 1 ? "One match" : `${numWord(n).charAt(0).toUpperCase() + numWord(n).slice(1)} matches`} for "${search}".`;
    }
    if (filter === "all") {
      const total = jobs.length;
      if (total === 0) return "No open positions.";
      return `${numWord(total).charAt(0).toUpperCase() + numWord(total).slice(1)} position${total !== 1 ? "s" : ""}, one studio.`;
    }
    return `${numWord(n).charAt(0).toUpperCase() + numWord(n).slice(1)} ${filter.toLowerCase()} ${n === 1 ? "role" : "roles"}.`;
  }

  return (
    <>
      {/* ───── HERO ───── */}
      <section className="ds-hero">
        <div className="hero-main">
          <div className="ds-hero-eyebrow ds-mono">
            <span className="issue-num">Open Call</span>
            <span className="pip" />
            <span>{jobs.length} position{jobs.length !== 1 ? "s" : ""}</span>
          </div>

          <h1 className="ds-hero-headline">
            We&apos;re building a team<br />
            that values craft,<br />
            calm, and real collaboration.
          </h1>

          <p className="ds-hero-lede">
            <span className="pull">Digital Sukoon is a calm, full-service marketing studio in Mumbai.</span>
            {" "}We&apos;re growing the team across multiple disciplines — full-time, internship, and contract. No agency burnout. Real work, real hours, real care for the craft.
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
            <a className="ds-btn ghost" href="https://digitalsukoon.com" target="_blank" rel="noopener noreferrer">
              Visit our studio
            </a>
          </div>
        </div>

        <aside className="ds-hero-aside" aria-label="Open call summary">
          {/* Cohort intake pill — count comes from the API */}
          <div className="ds-aside-pill">
            <span className="label">Cohort intake</span>
            <div className="count">
              {coldLoad ? "—" : pad2(jobs.length)}
              <em>&nbsp;position{jobs.length !== 1 ? "s" : ""}</em>
            </div>
            <p className="caption">
              {ftCount > 0 ? `${numWord(ftCount)} full-time` : ""}
              {internCount > 0 ? `${ftCount > 0 ? ", " : ""}${numWord(internCount)} internship` : ""}
              {contractCount > 0 ? `${(ftCount > 0 || internCount > 0) ? ", " : ""}${numWord(contractCount)} contract` : ""}
              {jobs.length === 0 ? "Check back soon for openings." : ""}
            </p>
          </div>
          <MiniCalendar jobs={jobs} />
        </aside>
      </section>

      {/* ───── ROLE INDEX ───── */}
      <section className="ds-index" id="index">
        <div className="ds-index-head">
          <div className="title">
            <span className="ds-mono">Now open</span>
            {/* Show the real title whenever we have jobs (server-seeded via
                initialJobs) so the indexable <h3> is never a "Loading…" placeholder
                for crawlers. Only show the loading text on a genuine cold load. */}
            <h3>{coldLoad ? "Loading positions…" : indexTitle()}</h3>
          </div>
          {/* Filter buttons — regular toggle buttons, not a tab pattern */}
          <div className="ds-filters">
            {[
              { key: "all", label: "All", count: jobs.length },
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
                {label} <span>· {count}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Search + view-all */}
        <div className="ds-search-row">
          <div className="ds-search">
            <span className="search-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="7" cy="7" r="4.5" />
                <path d="m10.5 10.5 3 3" />
              </svg>
            </span>
            <input
              ref={searchRef}
              type="text"
              placeholder="Search by role, department, or location…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoComplete="off"
            />
          </div>
          {!isLoading && jobs.length > 0 && (
            <a
              className="ds-btn ghost"
              href="#index"
              onClick={(e) => { e.preventDefault(); smoothScrollToId("index"); }}
              style={{ fontSize: 13, whiteSpace: "nowrap" }}
            >
              View all {jobs.length} →
            </a>
          )}
        </div>

        {/* Full-width role list — each row links to the role's own page */}
        <ol className="ds-roles" style={{ marginTop: 24 }}>
          {coldLoad ? (
            Array.from({ length: 4 }).map((_, i) => (
              <li key={i} style={{ height: 72, borderRadius: 14, background: "rgba(11,15,58,0.04)", marginBottom: 4 }} />
            ))
          ) : visibleJobs.length === 0 ? (
            <li className="ds-roles-empty">
              No roles match your search. Try a different keyword or clear the filter.
            </li>
          ) : (
            visibleJobs.map((job, idx) => {
              const color = getDeptColor(job.department);
              const isApplied = appliedIds.has(job.id);
              return (
                <li
                  key={job.id}
                  className={`ds-role ${isApplied ? "applied" : ""}`}
                  style={{ "--dept": color } as React.CSSProperties}
                  onClick={() => openJob(job)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openJob(job);
                    }
                  }}
                  tabIndex={0}
                  role="link"
                  aria-label={`${job.title}${job.department ? `, ${job.department}` : ""}${job.location ? `, ${job.location}` : ""}${isApplied ? ", already applied" : ""}`}
                >
                  <span className="num">{pad2(idx + 1)}</span>
                  <span className="dept-bar" />
                  <div className="info">
                    <div className="row1">
                      <span className="title">{job.title}</span>
                      {job.type === "INTERNSHIP" && <span className="tag">Internship</span>}
                    </div>
                    <div className="row2">
                      {job.department && <span className="dept">{job.department}</span>}
                      {job.department && job.location && <span className="sep" />}
                      {job.location && <span>{job.location}</span>}
                      {job.createdAt && (
                        <>
                          <span className="sep" />
                          <span>{timeAgo(job.createdAt)}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <span className="type-pill">
                    {isApplied ? "Applied" : TYPE_DISPLAY[job.type] || job.type}
                  </span>
                  <span className="ds-role-actions">
                    {/* Share this specific role straight from the list row. */}
                    <ShareButton slug={jobSlug(job)} jobTitle={job.title} variant="icon" className="go" />
                    {/* Apply CTA — deep-links to the role page with the form open.
                        stopPropagation so it doesn't double-fire with the row's own
                        navigation; it's a real link for middle-click / open-in-new-tab. */}
                    <Link
                      href={`/${jobSlug(job)}?apply=true`}
                      className="ds-role-apply"
                      aria-label={`Apply for the ${job.title} role`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      Apply now
                    </Link>
                  </span>
                </li>
              );
            })
          )}
        </ol>
      </section>

    </>
  );
}

// ───── MINI CALENDAR ─────
// Renders the current month dynamically — no hardcoded dates.
// Highlights today and any jobs posted this calendar month.
function MiniCalendar({ jobs }: { jobs: ApiJob[] }) {
  const [today, setToday] = useState<Date | null>(null);

  // Set on the client only to avoid SSR/hydration mismatch (new Date() differs server vs client).
  useEffect(() => { setToday(new Date()); }, []);

  if (!today) return null;

  const year = today.getFullYear();
  const month = today.getMonth();
  const monthLabel = today.toLocaleString("en-IN", { month: "long", year: "numeric" });
  const todayDate = today.getDate();

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();
  // Monday-first grid: convert JS Sunday-0 to Monday-0
  const startPad = (new Date(year, month, 1).getDay() + 6) % 7;

  // Highlight days in this month where a job was posted
  const eventDays = new Set(
    jobs
      .map(j => j.createdAt ? new Date(j.createdAt) : null)
      .filter((d): d is Date => d !== null && d.getFullYear() === year && d.getMonth() === month)
      .map(d => d.getDate())
  );

  const cells: { d: number; cls: string }[] = [];
  for (let i = startPad - 1; i >= 0; i--) {
    cells.push({ d: daysInPrevMonth - i, cls: "dim" });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ d, cls: d === todayDate ? "today" : eventDays.has(d) ? "event" : "" });
  }
  const nextPad = cells.length % 7 === 0 ? 0 : 7 - (cells.length % 7);
  for (let d = 1; d <= nextPad; d++) {
    cells.push({ d, cls: "dim" });
  }

  return (
    <div className="ds-aside-card">
      <span className="label ds-mono">{monthLabel}</span>
      <div className="ds-calendar" aria-hidden="true">
        {["M","T","W","T","F","S","S"].map((d, i) => (
          <span key={i} className="dow">{d}</span>
        ))}
        {cells.map((c, i) => (
          <span key={i} className={`d ${c.cls}`}>{c.d}</span>
        ))}
      </div>
      <div className="event-row">
        <span className="name"><span className="dot end" />Today</span>
        <span className="date">
          {today.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}
        </span>
      </div>
      {eventDays.size > 0 && (
        <div className="event-row">
          <span className="name"><span className="dot start" />Posted this month</span>
          <span className="date">{eventDays.size} role{eventDays.size !== 1 ? "s" : ""}</span>
        </div>
      )}
    </div>
  );
}
