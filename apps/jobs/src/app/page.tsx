"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import useSWR from "swr";
import { apiFetch, apiUpload } from "@/lib/api";
import { getDeptColor } from "@/lib/dept-colors";

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

function timeAgo(dateStr?: string): string {
  if (!dateStr) return "Recently posted";
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  if (days <= 0) return "Posted today";
  if (days === 1) return "Posted yesterday";
  if (days < 7) return `Posted ${days}d ago`;
  if (days < 30) return `Posted ${Math.round(days / 7)}w ago`;
  return `Posted ${Math.round(days / 30)}mo ago`;
}

function parseLines(text?: string): string[] {
  if (!text) return [];
  return text
    .split(/\n+/)
    .map((s) => s.replace(/^[-•*]\s*/, "").trim())
    .filter(Boolean);
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

const NUM_WORDS = ["zero","one","two","three","four","five","six","seven","eight","nine","ten",
  "eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen","twenty"];

function numWord(n: number): string {
  return NUM_WORDS[n] ?? String(n);
}

export default function JobsPage() {
  const { data, isLoading } = useSWR("/jobs", (url: string) => apiFetch<any>(url));

  // Memoize so the array reference is stable — prevents useEffect re-firing every render.
  const jobs: ApiJob[] = useMemo(() => data?.data ?? [], [data]);

  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set());

  // Apply modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [modalJob, setModalJob] = useState<ApiJob | null>(null);
  const [modalSuccess, setModalSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [applyForm, setApplyForm] = useState({
    fullName: "", email: "", phone: "", portfolioUrl: "", linkedinUrl: "", why: "",
  });
  const [applyFile, setApplyFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Toast
  const [toastMsg, setToastMsg] = useState("");
  const [toastVisible, setToastVisible] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function showToast(msg: string) {
    setToastMsg(msg);
    setToastVisible(true);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastVisible(false), 2400);
  }

  // Load saved/applied from localStorage (client-side hint only — server has the real state).
  useEffect(() => {
    try {
      const raw = localStorage.getItem("ds-careers-v1");
      if (raw) {
        const s = JSON.parse(raw);
        setSavedIds(new Set(s.saved || []));
        setAppliedIds(new Set(s.applied || []));
      }
    } catch {}
  }, []);

  // Auto-select the first job once jobs load. Stable jobs reference (useMemo above)
  // means this only fires when the actual list changes, not on every render.
  useEffect(() => {
    if (jobs.length && !selectedId) setSelectedId(jobs[0].id);
  }, [jobs, selectedId]);

  // Lock body scroll while modal is open; clean up on unmount or close.
  useEffect(() => {
    if (modalOpen) {
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = ""; };
    }
  }, [modalOpen]);

  function persist(saved: Set<string>, applied: Set<string>) {
    try {
      localStorage.setItem(
        "ds-careers-v1",
        JSON.stringify({ saved: Array.from(saved), applied: Array.from(applied) })
      );
    } catch {}
  }

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
      if (e.key === "Escape" && modalOpen) closeModal();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [modalOpen]);

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

  const selectedJob = visibleJobs.find((j) => j.id === selectedId) || visibleJobs[0] || null;

  const ftCount = jobs.filter((j) => j.type === "FULL_TIME").length;
  const internCount = jobs.filter((j) => j.type === "INTERNSHIP").length;
  const contractCount = jobs.filter((j) => j.type === "CONTRACT").length;

  function selectJob(id: string) {
    setSelectedId(id);
  }

  function toggleSave(id: string) {
    const next = new Set(savedIds);
    if (next.has(id)) {
      next.delete(id);
      showToast("Removed from saved");
    } else {
      next.add(id);
      showToast("Saved for later");
    }
    setSavedIds(next);
    persist(next, appliedIds);
  }

  function openModal(job: ApiJob) {
    setModalJob(job);
    setModalSuccess(false);
    setApplyForm({ fullName: "", email: "", phone: "", portfolioUrl: "", linkedinUrl: "", why: "" });
    setApplyFile(null);
    setModalOpen(true);
    // Body scroll lock is handled by the useEffect above.
  }

  function closeModal() {
    setModalOpen(false);
    setModalJob(null);
    // Body scroll unlock is handled by the useEffect cleanup above.
  }

  async function handleApply(e: React.FormEvent) {
    e.preventDefault();
    if (!modalJob) return;
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append("applicantName", applyForm.fullName);
      fd.append("applicantEmail", applyForm.email);
      if (applyForm.phone) fd.append("applicantPhone", applyForm.phone);
      // Keep field names aligned with what the API expects.
      if (applyForm.linkedinUrl) fd.append("linkedinUrl", applyForm.linkedinUrl);
      if (applyForm.portfolioUrl) fd.append("portfolioUrl", applyForm.portfolioUrl);
      if (applyForm.why) fd.append("coverLetter", applyForm.why);
      if (applyFile) fd.append("resume", applyFile);
      await apiUpload(`/jobs/${modalJob.id}/apply`, fd);

      const next = new Set(appliedIds);
      next.add(modalJob.id);
      setAppliedIds(next);
      persist(savedIds, next);
      setModalSuccess(true);
      showToast("Application sent ✓");
      // Don't auto-close — the success screen asks the user to note their confirmation.
    } catch (err: any) {
      // Use the toast (already in the design) instead of a blocking window.alert.
      showToast(err.message || "Submission failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
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

  function indexFoot() {
    const n = visibleJobs.length;
    const total = jobs.length;
    if (search) return `${n} of ${total} roles — clear search to see all.`;
    if (filter !== "all") return `Filtered to ${n} ${n === 1 ? "role" : "roles"} — switch filters to see the rest.`;
    return `Showing all ${numWord(total)} — full descriptions on click.`;
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
            We&apos;re hiring people<br />
            who want work<br />
            to feel like <em>sukoon</em>.
          </h1>

          <p className="ds-hero-lede">
            <span className="pull">Digital Sukoon is a calm, full-service marketing studio in Mumbai.</span>
            {" "}We&apos;re growing the team across multiple disciplines — full-time, internship, and contract. No agency burnout. Real work, real hours, real care for the craft.
          </p>

          <div className="ds-hero-ctas">
            <a className="ds-btn primary" href="#index">
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
              {isLoading ? "—" : pad2(jobs.length)}
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
            <span className="ds-mono">§ Now open</span>
            <h3>{isLoading ? "Loading positions…" : indexTitle()}</h3>
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
                onClick={() => {
                  setFilter(key);
                  const vis = jobs.filter((j) =>
                    key === "all" ? true : j.type === filterApiType[key]
                  );
                  if (vis.length && !vis.find((j) => j.id === selectedId)) {
                    setSelectedId(vis[0].id);
                  }
                }}
                type="button"
                aria-pressed={filter === key}
              >
                {label} <span>· {count}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Search */}
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
            onChange={(e) => {
              setSearch(e.target.value);
              const q = e.target.value.toLowerCase();
              const vis = jobs.filter((j) => {
                if (filter !== "all" && j.type !== filterApiType[filter]) return false;
                if (!q) return true;
                return (
                  j.title.toLowerCase().includes(q) ||
                  (j.department || "").toLowerCase().includes(q) ||
                  (j.location || "").toLowerCase().includes(q)
                );
              });
              if (vis.length && !vis.find((j) => j.id === selectedId)) {
                setSelectedId(vis[0].id);
              }
            }}
            autoComplete="off"
          />
          <kbd className="ds-search-hint">⌘ K</kbd>
        </div>

        {/* Master-detail */}
        <div className="ds-index-body">
          {/* Left: role list */}
          <ol className="ds-roles">
            {isLoading ? (
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
                const isActive = (selectedJob?.id ?? visibleJobs[0]?.id) === job.id;
                return (
                  <li
                    key={job.id}
                    className={`ds-role ${isActive ? "active" : ""} ${isApplied ? "applied" : ""}`}
                    style={{ "--dept": color } as React.CSSProperties}
                    onClick={() => selectJob(job.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        selectJob(job.id);
                      }
                    }}
                    tabIndex={0}
                    role="button"
                    aria-pressed={isActive}
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
                    <span className="go" aria-hidden="true">→</span>
                  </li>
                );
              })
            )}
          </ol>

          {/* Right: sticky detail — aria-live on the narrow status region, not the whole aside */}
          <aside className="ds-role-detail">
            {/* Announce only the job title to screen readers on selection change */}
            <span
              className="sr-only"
              aria-live="polite"
              aria-atomic="true"
            >
              {selectedJob ? `Viewing ${selectedJob.title}` : ""}
            </span>
            {!isLoading && selectedJob ? (
              <RoleDetail
                job={selectedJob}
                num={visibleJobs.findIndex((j) => j.id === selectedJob.id) + 1}
                total={jobs.length}
                isSaved={savedIds.has(selectedJob.id)}
                isApplied={appliedIds.has(selectedJob.id)}
                onApply={() => openModal(selectedJob)}
                onSave={() => toggleSave(selectedJob.id)}
              />
            ) : !isLoading && visibleJobs.length === 0 ? (
              <div className="ds-rd-body">
                <p style={{ color: "var(--muted)", fontSize: 14 }}>No roles match this filter.</p>
              </div>
            ) : (
              <div className="ds-rd-body">
                <div style={{ height: 8, borderRadius: 4, background: "rgba(11,15,58,0.08)", marginBottom: 20, width: "60%" }} />
                <div style={{ height: 36, borderRadius: 8, background: "rgba(11,15,58,0.06)", marginBottom: 14, width: "80%" }} />
                <div style={{ height: 14, borderRadius: 4, background: "rgba(11,15,58,0.04)", marginBottom: 8, width: "100%" }} />
                <div style={{ height: 14, borderRadius: 4, background: "rgba(11,15,58,0.04)", marginBottom: 8, width: "90%" }} />
                <div style={{ height: 14, borderRadius: 4, background: "rgba(11,15,58,0.04)", width: "70%" }} />
              </div>
            )}
          </aside>
        </div>

        <div className="ds-index-foot">
          <span>{isLoading ? "Loading…" : indexFoot()}</span>
          {!isLoading && jobs.length > 0 && (
            <a className="ds-btn ghost" href="#index" style={{ fontSize: 13 }}>
              View all {jobs.length} →
            </a>
          )}
        </div>
      </section>

      {/* ───── APPLY MODAL ───── */}
      {modalOpen && modalJob && (
        <div className="ds-modal-root" role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <div className="ds-modal-backdrop" onClick={closeModal} />
          <div className="ds-modal-card">
            <button className="ds-modal-close" onClick={closeModal} aria-label="Close">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M4 4 12 12M12 4 4 12" />
              </svg>
            </button>

            {modalSuccess ? (
              <div className="ds-modal-success">
                <div className="check" aria-hidden="true">✓</div>
                <h4 id="modal-title">Application sent!</h4>
                <p>
                  We&apos;ve got it. Expect a reply from the{" "}
                  {modalJob.department || "team"} within five working days.
                </p>
                <button className="ds-btn ghost" style={{ marginTop: 16 }} onClick={closeModal}>
                  Close
                </button>
              </div>
            ) : (
              <>
                <div className="ds-modal-head">
                  <span
                    className="ds-modal-eyebrow"
                    style={{ color: getDeptColor(modalJob.department) }}
                  >
                    {modalJob.department || "Open Role"}
                  </span>
                  <h3 id="modal-title">Apply — {modalJob.title}</h3>
                  <p className="ds-modal-sub">
                    {TYPE_DISPLAY[modalJob.type] || modalJob.type}
                    {modalJob.location ? ` · ${modalJob.location}` : ""}. Tell us why this role, in your own words.
                  </p>
                </div>

                <form onSubmit={handleApply}>
                  <div className="ds-form-grid">
                    <label className="ds-field">
                      <span className="label">Full Name <em>*</em></span>
                      <input
                        type="text"
                        required
                        value={applyForm.fullName}
                        onChange={(e) => setApplyForm({ ...applyForm, fullName: e.target.value })}
                        placeholder="Your full name"
                      />
                    </label>
                    <label className="ds-field">
                      <span className="label">Email <em>*</em></span>
                      <input
                        type="email"
                        required
                        value={applyForm.email}
                        onChange={(e) => setApplyForm({ ...applyForm, email: e.target.value })}
                        placeholder="you@example.com"
                      />
                    </label>
                    <label className="ds-field">
                      <span className="label">Phone</span>
                      <input
                        type="tel"
                        value={applyForm.phone}
                        onChange={(e) => setApplyForm({ ...applyForm, phone: e.target.value })}
                        placeholder="+91 — —————————"
                      />
                    </label>
                    <label className="ds-field">
                      <span className="label">LinkedIn URL</span>
                      <input
                        type="url"
                        value={applyForm.linkedinUrl}
                        onChange={(e) => setApplyForm({ ...applyForm, linkedinUrl: e.target.value })}
                        placeholder="https://linkedin.com/in/…"
                      />
                    </label>
                    <label className="ds-field">
                      <span className="label">Portfolio URL</span>
                      <input
                        type="url"
                        value={applyForm.portfolioUrl}
                        onChange={(e) => setApplyForm({ ...applyForm, portfolioUrl: e.target.value })}
                        placeholder="https://…"
                      />
                    </label>
                    <label className="ds-field full">
                      <span className="label">Why this role? <em>*</em></span>
                      <textarea
                        required
                        value={applyForm.why}
                        onChange={(e) => setApplyForm({ ...applyForm, why: e.target.value })}
                        rows={4}
                        placeholder="A few honest sentences — we'd rather hear three real lines than a pasted cover letter."
                      />
                    </label>
                    <div className="ds-field full">
                      <span className="label">Resume (PDF)</span>
                      <div className="ds-file-row">
                        <button
                          type="button"
                          className="ds-file-btn"
                          onClick={() => fileRef.current?.click()}
                        >
                          Choose File
                        </button>
                        <span className={`ds-file-name ${applyFile ? "has-file" : ""}`}>
                          {applyFile ? applyFile.name : "No file chosen"}
                        </span>
                        <input
                          ref={fileRef}
                          type="file"
                          accept=".pdf"
                          hidden
                          onChange={(e) => setApplyFile(e.target.files?.[0] ?? null)}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="ds-modal-actions">
                    <button type="button" className="cancel-btn" onClick={closeModal}>
                      Cancel
                    </button>
                    <button type="submit" className="ds-submit-btn" disabled={submitting}>
                      {submitting ? "Sending…" : "Send application"}
                      {!submitting && <span>→</span>}
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>
        </div>
      )}

      {/* Toast */}
      <div className={`ds-toast ${toastVisible ? "show" : ""}`} role="status" aria-live="polite">
        <span className="toast-icon">✓</span>
        <span>{toastMsg}</span>
      </div>
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

// ───── ROLE DETAIL PANEL ─────
function RoleDetail({
  job, num, total, isSaved, isApplied, onApply, onSave,
}: {
  job: ApiJob;
  num: number;
  total: number;
  isSaved: boolean;
  isApplied: boolean;
  onApply: () => void;
  onSave: () => void;
}) {
  const color = getDeptColor(job.department);
  const doingLines = parseLines(job.responsibilities);
  const lookingLines = parseLines(job.requirements);

  return (
    <>
      <div className="ds-rd-stripe" style={{ background: color }} />
      <div className="ds-rd-body entering">
        <div className="ds-rd-header">
          <span className="ds-rd-dept" style={{ color }}>
            {job.department || "Open Role"}
          </span>
          <span className="ds-rd-num">
            № {pad2(num)} / {pad2(total)}
          </span>
        </div>

        <h4 className="ds-rd-title">{job.title}</h4>

        <div className="ds-rd-activity">
          <span>
            <span className="dot" />
            {timeAgo(job.createdAt)}
          </span>
          {job._count?.applications ? (
            <span>· {job._count.applications} applied</span>
          ) : null}
        </div>

        <div className="ds-rd-meta">
          <span className="chip">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="8" cy="8" r="6" />
              <path d="M8 4.5V8l2.2 1.4" />
            </svg>
            {TYPE_DISPLAY[job.type] || job.type}
          </span>
          {job.location && (
            <span className="chip">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M8 14s-5-4.4-5-8.2A5 5 0 0 1 13 5.8C13 9.6 8 14 8 14Z" />
                <circle cx="8" cy="6" r="1.8" />
              </svg>
              {job.location}
            </span>
          )}
          {job.experience && (
            <span className="chip">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 13V8m5 5V4m5 9V9" />
              </svg>
              {job.experience}
            </span>
          )}
        </div>

        {isApplied && (
          <div className="ds-rd-applied-banner">
            <span className="ck">✓</span>
            <span>Application submitted — we&apos;ll be in touch.</span>
          </div>
        )}

        <p className="ds-rd-summary">{job.description}</p>

        {doingLines.length > 0 && (
          <div className="ds-rd-block" style={{ "--dept": color } as React.CSSProperties}>
            <h5>What you&apos;ll do</h5>
            <ul>
              {doingLines.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </div>
        )}

        {lookingLines.length > 0 && (
          <div className="ds-rd-block" style={{ "--dept": color } as React.CSSProperties}>
            <h5>What we&apos;re looking for</h5>
            <ul>
              {lookingLines.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </div>
        )}

        {job.benefits && (
          <div className="ds-rd-block" style={{ "--dept": color } as React.CSSProperties}>
            <h5>Benefits</h5>
            <ul>
              {parseLines(job.benefits).map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="ds-rd-actions">
          <button
            className="ds-btn primary"
            type="button"
            onClick={onApply}
            disabled={isApplied}
            style={{ flex: 1, justifyContent: "space-between", padding: "14px 18px 14px 22px" }}
          >
            {isApplied ? "Already applied" : "Apply for this role"}
            <span className="arrow">{isApplied ? "✓" : "→"}</span>
          </button>
          <button
            className={`ds-btn-icon ${isSaved ? "saved" : ""}`}
            type="button"
            onClick={onSave}
            aria-label={isSaved ? "Unsave" : "Save for later"}
          >
            <svg viewBox="0 0 20 20" fill={isSaved ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6">
              <path d="M5 3h10v15l-5-3.5L5 18V3Z" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    </>
  );
}
