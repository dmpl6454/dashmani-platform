"use client";

import { useEffect, useState } from "react";
import { apiFetch, API_BASE } from "@/lib/api";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { formatStatus } from "@dashmani/shared";
import { ModalPortal } from "@/components/modal-portal";
import useSWR from "swr";
import { Plus, ChevronUp, X, Trash2, RefreshCw, MapPin, Clock } from "lucide-react";

const DEPARTMENTS = [
  "Social Media", "Content Writing", "Graphic Design", "Video Production",
  "Web Development", "Marketing", "Business Development", "HR & Operations",
  "Sales", "Finance", "Engineering", "Other",
];

const rgba = (hex: string, a: number) => {
  if (hex.startsWith("var(")) return `color-mix(in srgb, ${hex} ${Math.round(a * 100)}%, transparent)`; const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
const HUES = ["var(--hx-238BFF)", "var(--hx-E9BD62)", "var(--hx-9B7EDE)", "var(--hx-00D7A0)", "var(--hx-FB7185)", "var(--hx-6EB2FF)"];
const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h); return Math.abs(h); };
const hueOf = (s: string) => HUES[hash(s || "?") % HUES.length];
const initials = (n: string) => (n || "?").trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();

const JSTAT: Record<string, [string, string]> = {
  ACTIVE: ["Active", "var(--hx-00D7A0)"], DRAFT: ["Draft", "var(--hx-A7B3C2)"], PAUSED: ["Paused", "var(--hx-E9BD62)"], CLOSED: ["Closed", "var(--hx-FB7185)"],
};
const ASTAT: Record<string, [string, string]> = {
  RECEIVED: ["New", "var(--hx-A7B3C2)"], REVIEWING: ["Reviewing", "var(--hx-6EB2FF)"], SHORTLISTED: ["Shortlisted", "var(--hx-9B7EDE)"],
  INTERVIEW: ["Interview", "var(--hx-E9BD62)"], OFFERED: ["Offered", "var(--hx-00D7A0)"], HIRED: ["Hired", "var(--hx-34D399)"], REJECTED: ["Rejected", "var(--hx-FB7185)"],
};
const appStatusSteps = ["RECEIVED", "REVIEWING", "SHORTLISTED", "INTERVIEW", "OFFERED", "HIRED"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const fdt = (s: string, long = false) => {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return "—";
  const hh = d.getHours(), mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getDate()} ${(long ? MONTHS_FULL : MONTHS)[d.getMonth()]} ${d.getFullYear()}, ${(hh % 12) || 12}:${mm} ${hh < 12 ? "am" : "pm"}`;
};

const IC = {
  mail: "M4 4h16v16H4zM22 6l-10 7L2 6",
  phone: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z",
  clock: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6v6l4 2",
  bldg: "M4 22V3h11v19M15 9h5v13M8 7h3M8 11h3M8 15h3M2 22h20",
  cv: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5",
  li: "M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6zM2 9h4v12H2zM4 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4z",
  globe: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20",
  brief: "M3 7h18v13H3zM8 7V4h8v3M3 13h18",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  reject: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM15 9l-6 6M9 9l6 6",
  reopen: "M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4L12 14l-3-3",
};

function Icon({ d, className = "h-4 w-4", sw = 1.9 }: { d: string; className?: string; sw?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${className}`} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function StatusChip({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 h-[26px] px-[11px] rounded-full border text-[11.5px] font-semibold whitespace-nowrap shrink-0"
      style={{ background: rgba(color, 0.1), borderColor: rgba(color, 0.3), color }}
    >
      <i className="h-[5px] w-[5px] rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

const FIELD =
  "w-full h-12 px-[18px] rounded-full border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[13.5px] outline-none [color-scheme:dark] placeholder:text-ds-t4 focus:border-[rgba(233,189,98,.6)] min-w-0";
const AREA =
  "w-full px-[18px] py-3.5 rounded-[18px] border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[13.5px] leading-[1.55] outline-none resize-none placeholder:text-ds-t4 focus:border-[rgba(233,189,98,.6)] min-w-0";
const GOLD_BTN =
  "inline-flex items-center gap-2 rounded-full bg-ds-gold text-[color:var(--hx-060D14)] font-bold whitespace-nowrap hover:bg-[color:var(--hx-F4D58C)] disabled:opacity-60";
const GHOST_SM =
  "h-8 px-3 rounded-full border border-ds-line2 text-ds-t5 text-[12px] font-semibold transition-colors";
const ERR_BOX =
  "px-3.5 py-2.5 rounded-[10px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] text-[color:var(--hx-FB7185)] text-[12.5px]";

type View = "jobs" | "applications";

export default function JobsPage() {
  usePageTitle("Job Listings");
  const [view, setView] = useState<View>("applications");
  const [showForm, setShowForm] = useState(false);
  const [editingJob, setEditingJob] = useState<any>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const [actionError, setActionError] = useState("");
  const [form, setForm] = useState({
    title: "", department: "", location: "", type: "FULL_TIME",
    experience: "", salary: "", description: "", requirements: "",
    responsibilities: "", benefits: "", status: "ACTIVE",
  });

  const [deleteJobId, setDeleteJobId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const { data, mutate } = useSWR("/admin/jobs", (url: string) => apiFetch<any>(url));
  const jobs = data?.data || [];

  const [selectedApp, setSelectedApp] = useState<any>(null);
  const [notesText, setNotesText] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);
  const [appJobFilter, setAppJobFilter] = useState("");
  const [appStatusFilter, setAppStatusFilter] = useState("");

  const { data: allAppsData, mutate: mutateApps, isValidating: appsValidating } = useSWR(
    `/admin/applications${appJobFilter ? `?jobId=${appJobFilter}` : ""}${appStatusFilter ? `${appJobFilter ? "&" : "?"}status=${appStatusFilter}` : ""}`,
    (url: string) => apiFetch<any>(url),
    { revalidateOnFocus: true, dedupingInterval: 10000 }
  );
  const allApps = allAppsData?.data || [];
  const newAppsCount = allApps.filter((a: any) => a.status === "RECEIVED").length;

  // Summary line — derived only from real data.
  const jobsLoaded = !!data;
  const activeCount = jobs.filter((j: any) => j.status === "ACTIVE").length;
  const countKnown = jobs.length > 0 && jobs.every((j: any) => typeof j._count?.applications === "number");
  const totalApps = countKnown ? jobs.reduce((s: number, j: any) => s + j._count.applications, 0) : null;
  const unfiltered = !appJobFilter && !appStatusFilter;
  const summaryParts: string[] = [];
  if (jobsLoaded) summaryParts.push(`${activeCount} open role${activeCount === 1 ? "" : "s"}`);
  if (totalApps !== null) summaryParts.push(`${totalApps} application${totalApps === 1 ? "" : "s"}`);
  if (allAppsData && unfiltered) summaryParts.push(`${newAppsCount} new`);
  const summary = summaryParts.length ? summaryParts.join(" · ") : "Post roles and review applications";

  useEffect(() => {
    if (!deleteJobId && !selectedApp) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (deleteJobId) { if (!deleting) setDeleteJobId(null); }
      else if (selectedApp) setSelectedApp(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteJobId, selectedApp, deleting]);

  function updateForm(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function startEdit(job: any) {
    setEditingJob(job);
    setForm({
      title: job.title, department: job.department || "", location: job.location || "",
      type: job.type, experience: job.experience || "", salary: job.salary || "",
      description: job.description, requirements: job.requirements || "",
      responsibilities: job.responsibilities || "", benefits: job.benefits || "",
      status: job.status,
    });
    setFormError("");
    setShowForm(true);
    setView("jobs");
  }

  function resetForm() {
    setForm({ title: "", department: "", location: "", type: "FULL_TIME", experience: "", salary: "", description: "", requirements: "", responsibilities: "", benefits: "", status: "ACTIVE" });
    setEditingJob(null);
    setShowForm(false);
    setFormError("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFormError("");
    try {
      if (editingJob) {
        await apiFetch(`/admin/jobs/${editingJob.id}`, { method: "PUT", body: JSON.stringify(form) });
      } else {
        await apiFetch("/admin/jobs", { method: "POST", body: JSON.stringify(form) });
      }
      resetForm();
      mutate();
    } catch (e: any) { setFormError(e?.message || "Failed to save the job listing."); }
    finally { setSubmitting(false); }
  }

  async function toggleJobStatus(id: string, status: string) {
    setActionError("");
    try {
      await apiFetch(`/admin/jobs/${id}`, { method: "PUT", body: JSON.stringify({ status }) });
      mutate();
    } catch (e: any) { setActionError(e?.message || "Failed to update the job status."); }
  }

  async function confirmDeleteJob() {
    if (!deleteJobId) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await apiFetch(`/admin/jobs/${deleteJobId}`, { method: "DELETE" });
      mutate();
      setDeleteJobId(null);
    } catch (e: any) { setDeleteError(e?.message || "Failed to delete the job listing."); }
    finally { setDeleting(false); }
  }

  async function updateAppStatus(appId: string, status: string) {
    setActionError("");
    try {
      await apiFetch(`/admin/applications/${appId}/status`, { method: "POST", body: JSON.stringify({ status }) });
      mutateApps();
      if (selectedApp?.id === appId) setSelectedApp((prev: any) => prev ? { ...prev, status } : null);
    } catch (e: any) { setActionError(e?.message || "Failed to update the application status."); }
  }

  async function saveNotes(appId: string) {
    setSavingNotes(true);
    setActionError("");
    try {
      await apiFetch(`/admin/applications/${appId}/notes`, { method: "PUT", body: JSON.stringify({ notes: notesText }) });
      mutateApps();
      if (selectedApp?.id === appId) setSelectedApp((prev: any) => prev ? { ...prev, notes: notesText } : null);
    } catch (e: any) { setActionError(e?.message || "Failed to save notes."); }
    finally { setSavingNotes(false); }
  }

  function openAppReview(app: any) {
    setActionError("");
    setSelectedApp(app);
    setNotesText(app.notes || "");
  }

  const views: { key: View; label: string; d: string; badge: number }[] = [
    { key: "applications", label: "Applications", d: IC.users, badge: newAppsCount },
    { key: "jobs", label: `Job Listings (${jobsLoaded ? jobs.length : "—"})`, d: IC.brief, badge: 0 },
  ];
  const deleteJob = deleteJobId ? jobs.find((j: any) => j.id === deleteJobId) : null;

  return (
    <div className="pb-8">
      {/* Header */}
      <section className="flex items-end justify-between gap-4 flex-wrap pt-[30px] pb-[22px]">
        <div className="flex-[1_1_300px] min-w-0">
          <div className="text-[11px] font-bold tracking-[.2em] uppercase text-ds-gold">Hiring</div>
          <h1 className="mt-1.5 text-[34px] sm:text-[38px] font-extrabold tracking-[-.035em] text-ds-text leading-tight">Job Listings</h1>
          <p className="mt-1.5 text-[13.5px] text-ds-t2">{summary}</p>
        </div>
        <button
          type="button"
          onClick={() => { if (showForm) resetForm(); else { setShowForm(true); setView("jobs"); } }}
          className={`${GOLD_BTN} h-[46px] px-[22px] text-[14px]`}
        >
          {showForm ? <ChevronUp className="h-[15px] w-[15px]" strokeWidth={2.4} /> : <Plus className="h-[15px] w-[15px]" strokeWidth={2.4} />}
          {showForm ? "Close" : "Post New Job"}
        </button>
      </section>

      {/* View toggle */}
      <section className="flex gap-1 p-[5px] rounded-full bg-ds-inset border border-ds-line2 w-max max-w-full overflow-x-auto mb-[18px]" role="tablist" aria-label="View">
        {views.map((v) => {
          const on = view === v.key;
          return (
            <button
              key={v.key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setView(v.key)}
              className={`inline-flex items-center gap-[9px] h-10 px-5 rounded-full text-[13.5px] font-bold whitespace-nowrap transition-colors ${on ? "bg-ds-gold text-[color:var(--hx-060D14)]" : "text-ds-t2 hover:text-ds-text"}`}
            >
              <Icon d={v.d} className="h-[15px] w-[15px]" />
              {v.label}
              {v.badge > 0 && (
                <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-[color:var(--hx-E5484D)] text-white text-[10.5px] font-extrabold inline-flex items-center justify-center">{v.badge}</span>
              )}
            </button>
          );
        })}
      </section>

      {actionError && !selectedApp && (
        <div className={`${ERR_BOX} mb-[18px] flex items-center justify-between gap-3`}>
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError("")} aria-label="Dismiss" className="shrink-0 hover:text-ds-text"><X className="h-4 w-4" /></button>
        </div>
      )}

      {/* Create / Edit form */}
      {showForm && view === "jobs" && (
        <form onSubmit={handleSubmit} className="relative rounded-[18px] border border-[color:var(--hx-2A4658)] bg-ds-card shadow-[0_12px_32px_rgba(0,0,0,.32)] px-5 py-6 sm:px-7 sm:py-[26px] mb-[18px] overflow-hidden">
          <span aria-hidden="true" className="absolute left-0 right-0 top-0 h-px bg-[linear-gradient(90deg,transparent,var(--hx-E9BD62)_30%,var(--hx-E9BD62)_70%,transparent)]" />
          <div className="text-[18px] font-bold tracking-[-.01em] text-ds-text mb-[18px]">{editingJob ? "Edit Job Listing" : "Create Job Listing"}</div>
          <div className="grid gap-x-4 gap-y-3.5 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
            <input type="text" placeholder="Job Title *" aria-label="Job Title" value={form.title} onChange={(e) => updateForm("title", e.target.value)} required className={FIELD} />
            <select value={form.department} aria-label="Department" onChange={(e) => updateForm("department", e.target.value)} className={`${FIELD} cursor-pointer`}>
              <option value="" className="bg-ds-card">Department</option>
              {DEPARTMENTS.map((d) => <option key={d} value={d} className="bg-ds-card">{d}</option>)}
            </select>
            <input type="text" placeholder="Location" aria-label="Location" value={form.location} onChange={(e) => updateForm("location", e.target.value)} className={FIELD} />
            <select value={form.type} aria-label="Job type" onChange={(e) => updateForm("type", e.target.value)} className={`${FIELD} cursor-pointer`}>
              <option value="FULL_TIME" className="bg-ds-card">Full Time</option>
              <option value="PART_TIME" className="bg-ds-card">Part Time</option>
              <option value="CONTRACT" className="bg-ds-card">Contract</option>
              <option value="INTERNSHIP" className="bg-ds-card">Internship</option>
              <option value="FREELANCE" className="bg-ds-card">Freelance</option>
            </select>
            <input type="text" placeholder="Experience (e.g., 2-4 years)" aria-label="Experience" value={form.experience} onChange={(e) => updateForm("experience", e.target.value)} className={FIELD} />
            <input type="text" placeholder="Salary (e.g., 3-5 LPA)" aria-label="Salary" value={form.salary} onChange={(e) => updateForm("salary", e.target.value)} className={FIELD} />
            <select value={form.status} aria-label="Status" onChange={(e) => updateForm("status", e.target.value)} className={`${FIELD} cursor-pointer`}>
              <option value="ACTIVE" className="bg-ds-card">Active</option>
              <option value="DRAFT" className="bg-ds-card">Draft</option>
              <option value="PAUSED" className="bg-ds-card">Paused</option>
              <option value="CLOSED" className="bg-ds-card">Closed</option>
            </select>
          </div>
          <div className="mt-3.5 grid gap-x-4 gap-y-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr))]">
            <textarea placeholder="Job Description *" aria-label="Job Description" value={form.description} onChange={(e) => updateForm("description", e.target.value)} required rows={4} className={AREA} />
            <textarea placeholder="Requirements (one per line)" aria-label="Requirements" value={form.requirements} onChange={(e) => updateForm("requirements", e.target.value)} rows={4} className={AREA} />
            <textarea placeholder="Responsibilities (one per line)" aria-label="Responsibilities" value={form.responsibilities} onChange={(e) => updateForm("responsibilities", e.target.value)} rows={4} className={AREA} />
            <textarea placeholder="Benefits (one per line)" aria-label="Benefits" value={form.benefits} onChange={(e) => updateForm("benefits", e.target.value)} rows={4} className={AREA} />
          </div>
          {formError && <div className={`${ERR_BOX} mt-3.5`}>{formError}</div>}
          <div className="flex justify-end gap-2.5 mt-5">
            {editingJob && (
              <button type="button" onClick={resetForm} className="h-11 px-[18px] rounded-full border border-ds-line2 text-ds-t2 text-[13px] font-semibold hover:text-ds-text">Cancel</button>
            )}
            <button type="submit" disabled={submitting} className={`${GOLD_BTN} h-11 px-[22px] text-[14px]`}>
              {submitting ? "Saving..." : editingJob ? "Update Job" : "Post Job"}
            </button>
          </div>
        </form>
      )}

      {/* ===== APPLICATIONS VIEW ===== */}
      {view === "applications" && (
        <section className="rounded-[18px] border border-[color:var(--hx-2A4658)] bg-ds-card shadow-[0_12px_32px_rgba(0,0,0,.32)] overflow-hidden">
          <div className="px-4 py-5 sm:px-6 sm:py-[22px] border-b border-[color:var(--hx-1A2C38)] flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <span className="text-[18px] font-bold tracking-[-.01em] text-ds-text">All Applications</span>
              <span className="flex items-center gap-3">
                <span className="text-[12px] text-ds-t3">{allAppsData ? `${allApps.length} total` : "—"}</span>
                <button
                  type="button"
                  onClick={() => mutateApps()}
                  className="inline-flex items-center gap-[7px] h-[34px] px-3.5 rounded-full border border-ds-line2 text-ds-t2 text-[12px] font-semibold hover:text-ds-text hover:border-[color:var(--hx-2A4658)]"
                >
                  <RefreshCw className={`h-3 w-3 ${appsValidating ? "motion-safe:animate-spin" : ""}`} />
                  {appsValidating ? "Refreshing…" : "Refresh"}
                </button>
              </span>
            </div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <select
                value={appJobFilter}
                onChange={(e) => setAppJobFilter(e.target.value)}
                aria-label="Filter by job"
                className="h-[38px] w-full sm:w-auto sm:min-w-[200px] max-w-full px-3.5 rounded-full border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[12.5px] outline-none [color-scheme:dark] cursor-pointer focus:border-[rgba(233,189,98,.6)]"
              >
                <option value="" className="bg-ds-card">All Jobs</option>
                {jobs.map((j: any) => <option key={j.id} value={j.id} className="bg-ds-card">{j.title}</option>)}
              </select>
              <div className="flex gap-1.5 overflow-x-auto [scrollbar-width:none] min-w-0 flex-[1_1_300px]">
                {["", "RECEIVED", "REVIEWING", "SHORTLISTED", "INTERVIEW", "OFFERED", "HIRED", "REJECTED"].map((s) => {
                  const on = appStatusFilter === s;
                  return (
                    <button
                      key={s || "all"}
                      type="button"
                      onClick={() => setAppStatusFilter(s)}
                      className={`h-8 px-3.5 rounded-full border text-[12px] font-semibold whitespace-nowrap shrink-0 transition-colors ${on ? "bg-ds-gold border-ds-gold text-[color:var(--hx-060D14)]" : "border-ds-line2 text-ds-t2 hover:text-ds-text"}`}
                    >
                      {s ? (ASTAT[s]?.[0] ?? formatStatus(s)) : "All"}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {!allAppsData ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-6 py-[18px] border-b border-[color:var(--hx-132430)]">
                <div className="h-11 w-11 rounded-full bg-ds-hover motion-safe:animate-pulse shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 w-40 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
                  <div className="h-3 w-56 max-w-full rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
                </div>
              </div>
            ))
          ) : allApps.length === 0 ? (
            <div className="py-14 px-5 flex flex-col items-center gap-2.5 text-ds-t3 text-[13px] text-center">
              <Icon d={IC.users} className="h-8 w-8" sw={1.5} />
              <span className="text-[14px] font-semibold text-ds-text">No applications yet</span>
              Applications from jobs.digitalsukoon.com will appear here
            </div>
          ) : (
            allApps.map((app: any) => {
              const hue = hueOf(app.applicantName || "");
              const on = selectedApp?.id === app.id;
              const [sl, sc] = ASTAT[app.status] ?? [formatStatus(app.status || ""), "var(--hx-A7B3C2)"];
              const tags = [
                app.resumeUrl && { l: "CV", fg: "var(--hx-6EB2FF)" },
                app.linkedinUrl && { l: "LinkedIn", fg: "var(--hx-6EB2FF)" },
                app.portfolioUrl && { l: "Portfolio", fg: "var(--hx-9B7EDE)" },
                app.notes && { l: "Notes", fg: "var(--hx-E9BD62)" },
              ].filter(Boolean) as { l: string; fg: string }[];
              return (
                <button
                  key={app.id}
                  type="button"
                  onClick={() => openAppReview(app)}
                  className="w-full grid [grid-template-columns:44px_minmax(0,1fr)] sm:[grid-template-columns:44px_minmax(0,1fr)_auto] gap-x-4 gap-y-2 items-center px-4 py-[18px] sm:px-6 border-b border-[color:var(--hx-132430)] last:border-b-0 text-left hover:bg-[color:var(--hx-0A1620)] transition-colors"
                  style={{ background: on ? "rgba(233,189,98,.07)" : undefined, boxShadow: `inset 3px 0 0 ${on ? "var(--hx-E9BD62)" : "transparent"}` }}
                >
                  <span
                    className="relative h-11 w-11 rounded-full grid place-items-center text-[14px] font-extrabold border"
                    style={{ background: rgba(hue, 0.12), borderColor: rgba(hue, 0.3), color: hue }}
                  >
                    {initials(app.applicantName)}
                    {app.status === "RECEIVED" && (
                      <i title="New" className="absolute top-0 right-0 h-[11px] w-[11px] rounded-full bg-[color:var(--hx-E5484D)] border-2 border-ds-card" />
                    )}
                  </span>
                  <span className="min-w-0 flex flex-col gap-1">
                    <span className="flex items-baseline gap-2.5 flex-wrap min-w-0">
                      <span className="text-[15.5px] font-bold text-ds-text break-words">{app.applicantName || "—"}</span>
                      <span className="text-[12px] text-ds-t3 break-all">{app.applicantEmail || "—"}</span>
                    </span>
                    <span className="flex items-center gap-2 flex-wrap text-[12.5px]">
                      <span className="text-ds-gold font-semibold">{app.job?.title || "Unknown"}{app.job?.department ? ` · ${app.job.department}` : ""}</span>
                      {app.experience && <span className="text-ds-t2">· {app.experience} exp{app.currentCompany ? ` at ${app.currentCompany}` : ""}</span>}
                    </span>
                    <span className="flex items-center gap-1.5 flex-wrap mt-0.5">
                      {tags.map((t) => (
                        <span key={t.l} className="h-5 px-2 rounded-[6px] bg-[color:var(--hx-0F1F2B)] border border-[color:var(--hx-1F3442)] text-[10.5px] font-semibold inline-flex items-center" style={{ color: t.fg }}>{t.l}</span>
                      ))}
                      <span className="text-[11px] text-[color:var(--hx-4A6275)] ml-1">{fdt(app.createdAt)}</span>
                    </span>
                  </span>
                  <span className="col-start-2 sm:col-start-auto">
                    <StatusChip label={sl} color={sc} />
                  </span>
                </button>
              );
            })
          )}
        </section>
      )}

      {/* ===== JOBS VIEW ===== */}
      {view === "jobs" && (
        <section className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr))]">
          {!data ? (
            Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-[250px] rounded-[18px] bg-ds-card border border-[color:var(--hx-2A4658)] motion-safe:animate-pulse" />
            ))
          ) : jobs.length === 0 ? (
            <div className="col-span-full rounded-[18px] border border-[color:var(--hx-2A4658)] bg-ds-card shadow-[0_12px_32px_rgba(0,0,0,.32)] py-14 px-5 flex flex-col items-center gap-2.5 text-ds-t3 text-[13px]">
              <Icon d={IC.brief} className="h-[30px] w-[30px]" sw={1.5} />
              No job listings yet.
            </div>
          ) : (
            jobs.map((job: any) => {
              const [sl, sc] = JSTAT[job.status] ?? [formatStatus(job.status || ""), "var(--hx-A7B3C2)"];
              const count = job._count?.applications;
              return (
                <div
                  key={job.id}
                  className="relative rounded-[18px] border border-[color:var(--hx-2A4658)] bg-ds-card shadow-[0_12px_32px_rgba(0,0,0,.32)] px-[22px] pt-[22px] pb-[18px] flex flex-col gap-4 overflow-hidden"
                  style={{ opacity: job.status === "CLOSED" ? 0.65 : 1 }}
                >
                  <span aria-hidden="true" className="absolute left-0 right-0 top-0 h-[2px] opacity-70" style={{ background: sc }} />
                  <div className="flex items-start justify-between gap-3">
                    <span className="h-[42px] w-[42px] rounded-[12px] bg-[rgba(233,189,98,.1)] border border-[rgba(233,189,98,.3)] text-ds-gold grid place-items-center shrink-0">
                      <Icon d={IC.brief} className="h-[18px] w-[18px]" sw={1.8} />
                    </span>
                    <StatusChip label={sl} color={sc} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[18px] font-extrabold tracking-[-.02em] leading-[1.25] text-ds-text [text-wrap:balance] break-words">{job.title}</div>
                    <div className="mt-1.5 text-[12.5px] text-ds-t2">{job.department || "—"}{job.experience ? ` · ${job.experience}` : ""}</div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <span className="inline-flex items-center gap-1.5 h-[26px] px-2.5 rounded-full bg-ds-inset border border-[color:var(--hx-1F3442)] text-ds-t5 text-[11.5px] font-semibold">
                      <MapPin className="h-[11px] w-[11px]" strokeWidth={2} />{job.location || "—"}
                    </span>
                    <span className="inline-flex items-center gap-1.5 h-[26px] px-2.5 rounded-full bg-ds-inset border border-[color:var(--hx-1F3442)] text-ds-t5 text-[11.5px] font-semibold">
                      <Clock className="h-[11px] w-[11px]" strokeWidth={2} />{job.type ? formatStatus(job.type) : "—"}
                    </span>
                    {job.salary && (
                      <span className="inline-flex items-center h-[26px] px-2.5 rounded-full bg-ds-inset border border-[color:var(--hx-1F3442)] text-ds-gold text-[11.5px] font-bold">{job.salary}</span>
                    )}
                  </div>
                  <div className="flex items-center justify-between flex-wrap gap-x-2.5 gap-y-3 pt-3.5 border-t border-[color:var(--hx-1A2C38)] mt-auto">
                    <button
                      type="button"
                      onClick={() => { setAppJobFilter(job.id); setAppStatusFilter(""); setView("applications"); }}
                      className="flex items-baseline gap-2 hover:opacity-80"
                    >
                      <span className="text-[28px] font-extrabold tracking-[-.04em] leading-none text-ds-gold tabular-nums">{typeof count === "number" ? count : "—"}</span>
                      <span className="text-[12px] font-semibold text-ds-t2 whitespace-nowrap">applicants →</span>
                    </button>
                    <span className="flex items-center gap-1.5">
                      <button type="button" onClick={() => startEdit(job)} className={`${GHOST_SM} hover:border-[rgba(233,189,98,.5)] hover:text-ds-gold`}>Edit</button>
                      {job.status === "ACTIVE" ? (
                        <button type="button" onClick={() => toggleJobStatus(job.id, "PAUSED")} className={`${GHOST_SM} hover:border-[color:var(--hx-2A4658)] hover:text-ds-text`}>Pause</button>
                      ) : job.status !== "CLOSED" ? (
                        <button type="button" onClick={() => toggleJobStatus(job.id, "ACTIVE")} className={`${GHOST_SM} hover:border-[color:var(--hx-2A4658)] hover:text-ds-text`}>Activate</button>
                      ) : null}
                      {job.status === "ACTIVE" && (
                        <button type="button" onClick={() => toggleJobStatus(job.id, "CLOSED")} className={`${GHOST_SM} hover:border-[rgba(229,72,77,.5)] hover:text-[color:var(--hx-FB7185)]`}>Close</button>
                      )}
                      <button
                        type="button"
                        onClick={() => { setDeleteError(""); setDeleteJobId(job.id); }}
                        title="Delete"
                        aria-label={`Delete ${job.title}`}
                        className="h-8 w-8 rounded-full border border-ds-line2 text-ds-t3 grid place-items-center hover:text-[color:var(--hx-FB7185)] hover:border-[rgba(229,72,77,.5)] transition-colors"
                      >
                        <Trash2 className="h-[13px] w-[13px]" />
                      </button>
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </section>
      )}

      {/* Application review drawer */}
      {selectedApp && (() => {
        const hue = hueOf(selectedApp.applicantName || "");
        const [sl, sc] = ASTAT[selectedApp.status] ?? [formatStatus(selectedApp.status || ""), "var(--hx-A7B3C2)"];
        const currentIdx = appStatusSteps.indexOf(selectedApp.status);
        const facts = [
          { d: IC.mail, v: selectedApp.applicantEmail },
          selectedApp.applicantPhone && { d: IC.phone, v: selectedApp.applicantPhone },
          selectedApp.experience && { d: IC.clock, v: selectedApp.experience },
          selectedApp.currentCompany && { d: IC.bldg, v: selectedApp.currentCompany },
        ].filter(Boolean) as { d: string; v: string }[];
        const links = [
          { href: selectedApp.resumeUrl ? `${API_BASE}${selectedApp.resumeUrl}` : null, on: "View CV", off: "No Resume", d: IC.cv, c: "var(--hx-FB7185)" },
          { href: selectedApp.linkedinUrl || null, on: "LinkedIn", off: "No LinkedIn", d: IC.li, c: "var(--hx-6EB2FF)" },
          { href: selectedApp.portfolioUrl || null, on: "Portfolio", off: "No Portfolio", d: IC.globe, c: "var(--hx-9B7EDE)" },
        ];
        return (
          <ModalPortal>
            <div className="ds-root contents">
              <div className="fixed inset-0 z-50 flex justify-end bg-[rgba(2,6,10,.6)]" onClick={() => setSelectedApp(null)}>
                <div
                  onClick={(e) => e.stopPropagation()}
                  role="dialog"
                  aria-modal="true"
                  aria-label={`Application from ${selectedApp.applicantName}`}
                  className="w-full max-w-[560px] h-full overflow-y-auto bg-ds-card border-l border-ds-line2 shadow-[-24px_0_60px_rgba(0,0,0,.5)] px-5 py-6 sm:px-7 sm:py-[26px] flex flex-col gap-[22px] text-ds-text"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-4 min-w-0">
                      <span
                        className="h-[58px] w-[58px] rounded-full grid place-items-center text-[19px] font-extrabold shrink-0 border"
                        style={{ background: rgba(hue, 0.12), borderColor: rgba(hue, 0.3), color: hue }}
                      >
                        {initials(selectedApp.applicantName)}
                      </span>
                      <div className="min-w-0">
                        <div className="text-[11px] font-bold tracking-[.14em] uppercase text-ds-gold break-words">Applied for · {selectedApp.job?.title || "Unknown Position"}</div>
                        <div className="mt-[5px] text-[22px] sm:text-[26px] font-extrabold tracking-[-.03em] leading-[1.1] break-words">{selectedApp.applicantName || "—"}</div>
                      </div>
                    </div>
                    <button type="button" onClick={() => setSelectedApp(null)} aria-label="Close" className="h-9 w-9 rounded-full border border-ds-line2 text-ds-t2 grid place-items-center shrink-0 hover:text-ds-text">
                      <X className="h-[15px] w-[15px]" />
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {facts.map((x, i) => (
                      <span key={i} className="flex items-center gap-2.5 px-3.5 py-3 rounded-[12px] bg-ds-inset border border-[color:var(--hx-1A2C38)] text-[12.5px] text-ds-t5 min-w-0">
                        <span className="text-ds-t3 flex"><Icon d={x.d} className="h-3.5 w-3.5" /></span>
                        <span className="truncate" title={x.v}>{x.v || "—"}</span>
                      </span>
                    ))}
                  </div>

                  <div className="p-[18px] rounded-[16px] bg-ds-inset border border-[color:var(--hx-1A2C38)]">
                    <div className="text-[11px] font-bold tracking-[.14em] uppercase text-ds-t3 mb-3">Application Pipeline</div>
                    <div className="grid grid-cols-3 sm:grid-cols-6 gap-1">
                      {appStatusSteps.map((step, i) => {
                        const cur = step === selectedApp.status;
                        const act = i <= currentIdx;
                        return (
                          <button
                            key={step}
                            type="button"
                            onClick={() => updateAppStatus(selectedApp.id, step)}
                            className="h-[34px] rounded-[8px] border text-[11px] font-bold whitespace-nowrap overflow-hidden text-ellipsis px-1 transition-colors"
                            style={{
                              background: cur ? "var(--hx-E9BD62)" : act ? "rgba(233,189,98,.18)" : "transparent",
                              color: cur ? "var(--hx-060D14)" : act ? "var(--hx-F4F6F8)" : "var(--hx-738395)",
                              borderColor: cur ? "var(--hx-E9BD62)" : act ? "rgba(233,189,98,.35)" : "var(--hx-223543)",
                            }}
                          >
                            {ASTAT[step][0]}
                          </button>
                        );
                      })}
                    </div>
                    <div className="flex items-center justify-between gap-2.5 mt-3.5 flex-wrap">
                      <StatusChip label={sl} color={sc} />
                      {selectedApp.status !== "REJECTED" ? (
                        <button type="button" onClick={() => updateAppStatus(selectedApp.id, "REJECTED")} className="inline-flex items-center gap-1.5 text-[color:var(--hx-FB7185)] text-[12.5px] font-semibold hover:opacity-80">
                          <Icon d={IC.reject} className="h-3.5 w-3.5" />Reject Applicant
                        </button>
                      ) : (
                        <button type="button" onClick={() => updateAppStatus(selectedApp.id, "RECEIVED")} className="inline-flex items-center gap-1.5 text-ds-teal text-[12.5px] font-semibold hover:opacity-80">
                          <Icon d={IC.reopen} className="h-3.5 w-3.5" />Reopen Application
                        </button>
                      )}
                    </div>
                  </div>

                  {actionError && (
                    <div className={`${ERR_BOX} flex items-center justify-between gap-3`}>
                      <span>{actionError}</span>
                      <button type="button" onClick={() => setActionError("")} aria-label="Dismiss" className="shrink-0 hover:text-ds-text"><X className="h-4 w-4" /></button>
                    </div>
                  )}

                  <div className="grid grid-cols-3 gap-2.5">
                    {links.map((l) =>
                      l.href ? (
                        <a
                          key={l.on}
                          href={l.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex flex-col items-center gap-2 px-2.5 py-4 rounded-[14px] border border-ds-line2 bg-ds-inset text-[12.5px] font-semibold text-center hover:border-[rgba(233,189,98,.5)] transition-colors"
                          style={{ color: l.c }}
                        >
                          <Icon d={l.d} className="h-[18px] w-[18px]" sw={1.8} />{l.on}
                        </a>
                      ) : (
                        <div key={l.on} className="flex flex-col items-center gap-2 px-2.5 py-4 rounded-[14px] border border-[color:var(--hx-1A2C38)] bg-ds-inset text-[color:var(--hx-4A6275)] text-[12.5px] font-semibold text-center opacity-70">
                          <Icon d={l.d} className="h-[18px] w-[18px]" sw={1.8} />{l.off}
                        </div>
                      )
                    )}
                  </div>

                  {selectedApp.coverLetter && (
                    <div>
                      <div className="text-[11px] font-bold tracking-[.14em] uppercase text-ds-t3 mb-2.5">Cover Letter</div>
                      <div className="px-[18px] py-4 rounded-[14px] bg-ds-inset border border-[color:var(--hx-1A2C38)] text-[13.5px] leading-[1.65] text-[color:var(--hx-C9D2DC)] whitespace-pre-line break-words">
                        {selectedApp.coverLetter}
                      </div>
                    </div>
                  )}

                  <div>
                    <div className="text-[11px] font-bold tracking-[.14em] uppercase text-ds-t3 mb-2.5">Review Notes</div>
                    <textarea
                      value={notesText}
                      onChange={(e) => setNotesText(e.target.value)}
                      placeholder="Add internal notes about this applicant..."
                      aria-label="Review notes"
                      rows={3}
                      className={AREA}
                    />
                    <div className="flex justify-end mt-2.5">
                      <button type="button" onClick={() => saveNotes(selectedApp.id)} disabled={savingNotes} className={`${GOLD_BTN} h-[38px] px-[18px] text-[12.5px]`}>
                        {savingNotes ? "Saving..." : "Save Notes"}
                      </button>
                    </div>
                  </div>

                  <div className="text-[12px] text-ds-t3">Applied on {fdt(selectedApp.createdAt, true)}</div>
                </div>
              </div>
            </div>
          </ModalPortal>
        );
      })()}

      {/* Delete confirmation */}
      {deleteJobId && (
        <ModalPortal>
          <div className="ds-root contents">
            <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-[rgba(2,6,10,.72)]" onClick={() => !deleting && setDeleteJobId(null)}>
              <div
                onClick={(e) => e.stopPropagation()}
                role="alertdialog"
                aria-modal="true"
                aria-label="Delete job listing?"
                className="w-full max-w-[380px] bg-ds-card border border-ds-line2 rounded-[16px] p-6 shadow-[0_20px_50px_rgba(0,0,0,.6)] text-ds-text"
              >
                <div className="h-10 w-10 rounded-[11px] bg-[rgba(229,72,77,.12)] text-[color:var(--hx-FB7185)] grid place-items-center">
                  <Trash2 className="h-[17px] w-[17px]" />
                </div>
                <div className="mt-3.5 text-[15px] font-semibold">Delete job listing?</div>
                <div className="mt-1.5 text-[12.5px] leading-[1.5] text-ds-t2">
                  {deleteJob ? <><b className="text-ds-text font-semibold">{deleteJob.title}</b> will be removed. </> : null}This cannot be undone.
                </div>
                {deleteError && <div className={`${ERR_BOX} mt-3.5`}>{deleteError}</div>}
                <div className="flex justify-end gap-2 mt-[22px]">
                  <button type="button" onClick={() => setDeleteJobId(null)} disabled={deleting} className="h-[38px] px-4 rounded-full border border-ds-line2 text-ds-t2 text-[13px] font-semibold hover:text-ds-text disabled:opacity-50">
                    Cancel
                  </button>
                  <button type="button" onClick={confirmDeleteJob} disabled={deleting} className="h-[38px] px-[18px] rounded-full bg-[color:var(--hx-E5484D)] text-white text-[13px] font-bold disabled:opacity-60">
                    {deleting ? "Deleting..." : "Delete"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </ModalPortal>
      )}
    </div>
  );
}
