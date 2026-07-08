"use client";

import { useState } from "react";
import { apiFetch, API_BASE } from "@/lib/api";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { formatStatus } from "@dashmani/shared";
import { ConfirmDialog } from "@dashmani/ui";
import useSWR from "swr";
import {
  Briefcase, Plus, ChevronUp, Users, X, FileText, Linkedin,
  Globe, Phone, Mail, Building2, Clock, Trash2,
  ExternalLink, StickyNote, CheckCircle, XCircle, Eye, RefreshCw,
} from "lucide-react";

const inputClass = "w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors";

const DEPARTMENTS = [
  "Social Media", "Content Writing", "Graphic Design", "Video Production",
  "Web Development", "Marketing", "Business Development", "HR & Operations",
  "Sales", "Finance", "Engineering", "Other",
];

const statusColors: Record<string, string> = {
  ACTIVE: "bg-green-50 text-green-700",
  DRAFT: "bg-gray-100 text-gray-700",
  PAUSED: "bg-yellow-50 text-yellow-700",
  CLOSED: "bg-red-50 text-red-700",
};

const appStatusColors: Record<string, string> = {
  RECEIVED: "bg-gray-100 text-gray-700",
  REVIEWING: "bg-blue-50 text-blue-700",
  SHORTLISTED: "bg-purple-50 text-purple-700",
  INTERVIEW: "bg-yellow-50 text-yellow-700",
  OFFERED: "bg-green-50 text-green-700",
  HIRED: "bg-emerald-50 text-emerald-700",
  REJECTED: "bg-red-50 text-red-700",
};

const appStatusSteps = ["RECEIVED", "REVIEWING", "SHORTLISTED", "INTERVIEW", "OFFERED", "HIRED"];

type View = "jobs" | "applications";

export default function JobsPage() {
  usePageTitle("Job Listings");
  const [view, setView] = useState<View>("applications");
  const [showForm, setShowForm] = useState(false);
  const [editingJob, setEditingJob] = useState<any>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    title: "", department: "", location: "", type: "FULL_TIME",
    experience: "", salary: "", description: "", requirements: "",
    responsibilities: "", benefits: "", status: "ACTIVE",
  });

  const [deleteJobId, setDeleteJobId] = useState<string | null>(null);

  const { data, mutate } = useSWR("/admin/jobs", (url: string) => apiFetch<any>(url));
  const jobs = data?.data || [];

  const [selectedApp, setSelectedApp] = useState<any>(null);
  const [notesText, setNotesText] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);
  const [appJobFilter, setAppJobFilter] = useState("");
  const [appStatusFilter, setAppStatusFilter] = useState("");

  const { data: allAppsData, mutate: mutateApps } = useSWR(
    `/admin/applications${appJobFilter ? `?jobId=${appJobFilter}` : ""}${appStatusFilter ? `${appJobFilter ? "&" : "?"}status=${appStatusFilter}` : ""}`,
    (url: string) => apiFetch<any>(url),
    { revalidateOnFocus: true, dedupingInterval: 10000 }
  );
  const allApps = allAppsData?.data || [];
  const newAppsCount = allApps.filter((a: any) => a.status === "RECEIVED").length;

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
    setShowForm(true);
    setView("jobs");
  }

  function resetForm() {
    setForm({ title: "", department: "", location: "", type: "FULL_TIME", experience: "", salary: "", description: "", requirements: "", responsibilities: "", benefits: "", status: "ACTIVE" });
    setEditingJob(null);
    setShowForm(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      if (editingJob) {
        await apiFetch(`/admin/jobs/${editingJob.id}`, { method: "PUT", body: JSON.stringify(form) });
      } else {
        await apiFetch("/admin/jobs", { method: "POST", body: JSON.stringify(form) });
      }
      resetForm();
      mutate();
    } catch (e: any) { alert(e.message); }
    finally { setSubmitting(false); }
  }

  async function toggleJobStatus(id: string, status: string) {
    try {
      await apiFetch(`/admin/jobs/${id}`, { method: "PUT", body: JSON.stringify({ status }) });
      mutate();
    } catch (e: any) { alert(e.message); }
  }

  async function confirmDeleteJob() {
    if (!deleteJobId) return;
    try {
      await apiFetch(`/admin/jobs/${deleteJobId}`, { method: "DELETE" });
      mutate();
    } catch (e: any) { alert(e.message); }
    finally { setDeleteJobId(null); }
  }

  async function updateAppStatus(appId: string, status: string) {
    try {
      await apiFetch(`/admin/applications/${appId}/status`, { method: "POST", body: JSON.stringify({ status }) });
      mutateApps();
      if (selectedApp?.id === appId) setSelectedApp((prev: any) => prev ? { ...prev, status } : null);
    } catch (e: any) { alert(e.message); }
  }

  async function saveNotes(appId: string) {
    setSavingNotes(true);
    try {
      await apiFetch(`/admin/applications/${appId}/notes`, { method: "PUT", body: JSON.stringify({ notes: notesText }) });
      mutateApps();
      if (selectedApp?.id === appId) setSelectedApp((prev: any) => prev ? { ...prev, notes: notesText } : null);
    } catch (e: any) { alert(e.message); }
    finally { setSavingNotes(false); }
  }

  function openAppReview(app: any) {
    setSelectedApp(app);
    setNotesText(app.notes || "");
  }

  return (
    <div className="space-y-6 crx-animate-fade">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">Job Listings</h1>
        <div className="flex items-center gap-3">
          <button onClick={() => { if (showForm) resetForm(); else { setShowForm(true); setView("jobs"); } }} className="bg-[#1A1A1A] text-white py-2.5 px-6 rounded-full font-semibold hover:bg-[#2B2B2B] transition-all flex items-center gap-2">
            {showForm ? <ChevronUp size={16} /> : <Plus size={16} />}
            {showForm ? "Close" : "Post New Job"}
          </button>
        </div>
      </div>

      {/* View Toggle */}
      <div className="flex flex-wrap gap-2">
        <button onClick={() => setView("applications")}
          className={`flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-medium transition-all ${view === "applications" ? "bg-[#1A1A1A] text-white" : "bg-white text-[#7A7A7A] border border-[#E8E0D0] hover:border-[#F5D547]"}`}>
          <Users size={16} />Applications
          {newAppsCount > 0 && <span className="bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">{newAppsCount}</span>}
        </button>
        <button onClick={() => setView("jobs")}
          className={`flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-medium transition-all ${view === "jobs" ? "bg-[#1A1A1A] text-white" : "bg-white text-[#7A7A7A] border border-[#E8E0D0] hover:border-[#F5D547]"}`}>
          <Briefcase size={16} />Job Listings ({jobs.length})
        </button>
      </div>

      {/* Create / Edit Form */}
      {showForm && view === "jobs" && (
        <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-5">
          <p className="font-medium text-[#1A1A1A] mb-4">{editingJob ? "Edit Job Listing" : "Create Job Listing"}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <input type="text" placeholder="Job Title *" value={form.title} onChange={(e) => updateForm("title", e.target.value)} required className={inputClass} />
            <select value={form.department} onChange={(e) => updateForm("department", e.target.value)} className={inputClass}>
              <option value="">Department</option>
              {DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <input type="text" placeholder="Location" value={form.location} onChange={(e) => updateForm("location", e.target.value)} className={inputClass} />
            <select value={form.type} onChange={(e) => updateForm("type", e.target.value)} className={inputClass}>
              <option value="FULL_TIME">Full Time</option><option value="PART_TIME">Part Time</option><option value="CONTRACT">Contract</option><option value="INTERNSHIP">Internship</option><option value="FREELANCE">Freelance</option>
            </select>
            <input type="text" placeholder="Experience (e.g., 2-4 years)" value={form.experience} onChange={(e) => updateForm("experience", e.target.value)} className={inputClass} />
            <input type="text" placeholder="Salary (e.g., 3-5 LPA)" value={form.salary} onChange={(e) => updateForm("salary", e.target.value)} className={inputClass} />
            <select value={form.status} onChange={(e) => updateForm("status", e.target.value)} className={inputClass}>
              <option value="ACTIVE">Active</option><option value="DRAFT">Draft</option><option value="PAUSED">Paused</option><option value="CLOSED">Closed</option>
            </select>
          </div>
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <textarea placeholder="Job Description *" value={form.description} onChange={(e) => updateForm("description", e.target.value)} required rows={4} className={inputClass + " resize-none"} />
            <textarea placeholder="Requirements (one per line)" value={form.requirements} onChange={(e) => updateForm("requirements", e.target.value)} rows={4} className={inputClass + " resize-none"} />
            <textarea placeholder="Responsibilities (one per line)" value={form.responsibilities} onChange={(e) => updateForm("responsibilities", e.target.value)} rows={4} className={inputClass + " resize-none"} />
            <textarea placeholder="Benefits (one per line)" value={form.benefits} onChange={(e) => updateForm("benefits", e.target.value)} rows={4} className={inputClass + " resize-none"} />
          </div>
          <div className="mt-5 flex justify-end gap-3">
            {editingJob && <button type="button" onClick={resetForm} className="text-sm text-[#7A7A7A] hover:text-[#1A1A1A]">Cancel</button>}
            <button type="submit" disabled={submitting} className="bg-[#1A1A1A] text-white py-2.5 px-6 rounded-full font-semibold hover:bg-[#2B2B2B] disabled:opacity-50">
              {submitting ? "Saving..." : editingJob ? "Update Job" : "Post Job"}
            </button>
          </div>
        </form>
      )}

      {/* ===== APPLICATIONS VIEW ===== */}
      {view === "applications" && (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0]">
          <div className="p-5 border-b border-[#F0EAD8]">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-[#1A1A1A] text-lg">All Applications</h3>
              <div className="flex items-center gap-3">
                <p className="text-xs text-[#7A7A7A]">{allApps.length} total</p>
                <button
                  onClick={() => mutateApps()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white border border-[#E8E0D0] text-[#7A7A7A] hover:border-[#F5D547] transition-colors"
                >
                  <RefreshCw size={12} />
                  Refresh
                </button>
              </div>
            </div>
            {/* Filters */}
            <div className="flex flex-wrap gap-3">
              <select value={appJobFilter} onChange={(e) => setAppJobFilter(e.target.value)} className={inputClass + " !w-auto"}>
                <option value="">All Jobs</option>
                {jobs.map((j: any) => <option key={j.id} value={j.id}>{j.title}</option>)}
              </select>
              <div className="flex gap-1.5 flex-wrap">
                {["", "RECEIVED", "REVIEWING", "SHORTLISTED", "INTERVIEW", "OFFERED", "HIRED", "REJECTED"].map((s) => (
                  <button key={s} onClick={() => setAppStatusFilter(s)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${appStatusFilter === s ? "bg-[#1A1A1A] text-white" : "bg-white text-[#7A7A7A] border border-[#E8E0D0] hover:border-[#F5D547]"}`}
                  >{s || "All"}</button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex">
            {/* Applications List */}
            <div className={`${selectedApp ? "w-2/5 border-r border-[#F0EAD8]" : "w-full"} divide-y divide-[#F0EAD8] max-h-[700px] overflow-y-auto`}>
              {allApps.length === 0 ? (
                <div className="p-10 text-center text-[#7A7A7A]">
                  <Users size={32} className="mx-auto mb-3 opacity-30" />
                  <p className="font-medium mb-1">No applications yet</p>
                  <p className="text-sm">Applications from jobs.digitalsukoon.com will appear here</p>
                </div>
              ) : allApps.map((app: any) => (
                <div key={app.id}
                  onClick={() => openAppReview(app)}
                  className={`p-4 cursor-pointer hover:bg-[#FEFCF7] transition-colors ${selectedApp?.id === app.id ? "bg-[rgba(245,213,71,0.08)] border-l-2 border-l-[#F5D547]" : ""}`}>
                  <div className="flex items-start justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-[#1A1A1A] truncate">{app.applicantName}</p>
                        {app.status === "RECEIVED" && <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" title="New" />}
                      </div>
                      <p className="text-xs text-[#7A7A7A] truncate">{app.applicantEmail}</p>
                      <p className="text-xs text-blue-600 mt-0.5">{app.job?.title || "Unknown"} {app.job?.department ? `· ${app.job.department}` : ""}</p>
                      {app.experience && <p className="text-xs text-[#999] mt-0.5">{app.experience} exp {app.currentCompany ? `at ${app.currentCompany}` : ""}</p>}
                    </div>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium whitespace-nowrap ${appStatusColors[app.status] || ""}`}>{formatStatus(app.status)}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    {app.resumeUrl && <span className="text-[10px] text-blue-600 flex items-center gap-0.5"><FileText size={10} />CV</span>}
                    {app.linkedinUrl && <span className="text-[10px] text-blue-600 flex items-center gap-0.5"><Linkedin size={10} />LI</span>}
                    {app.portfolioUrl && <span className="text-[10px] text-blue-600 flex items-center gap-0.5"><Globe size={10} />Portfolio</span>}
                    {app.notes && <span className="text-[10px] text-amber-600 flex items-center gap-0.5"><StickyNote size={10} />Notes</span>}
                  </div>
                  <p className="text-[10px] text-[#B0B0B0] mt-1">{new Date(app.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</p>
                </div>
              ))}
            </div>

            {/* Application Detail Panel */}
            {selectedApp && (
              <div className="w-3/5 max-h-[700px] overflow-y-auto">
                <div className="p-5 space-y-5">
                  {/* Close */}
                  <div className="flex justify-end">
                    <button onClick={() => setSelectedApp(null)} className="text-[#7A7A7A] hover:text-[#1A1A1A]"><X size={16} /></button>
                  </div>

                  {/* Applicant Header */}
                  <div>
                    <p className="text-xs text-blue-600 font-medium mb-1">Applied for: {selectedApp.job?.title || "Unknown Position"}</p>
                    <h4 className="text-xl font-semibold text-[#1A1A1A]">{selectedApp.applicantName}</h4>
                    <div className="flex items-center gap-3 mt-1 text-sm text-[#7A7A7A]">
                      <span className="flex items-center gap-1"><Mail size={13} />{selectedApp.applicantEmail}</span>
                      {selectedApp.applicantPhone && <span className="flex items-center gap-1"><Phone size={13} />{selectedApp.applicantPhone}</span>}
                    </div>
                    {(selectedApp.experience || selectedApp.currentCompany) && (
                      <div className="flex items-center gap-3 mt-1 text-sm text-[#7A7A7A]">
                        {selectedApp.experience && <span className="flex items-center gap-1"><Clock size={13} />{selectedApp.experience}</span>}
                        {selectedApp.currentCompany && <span className="flex items-center gap-1"><Building2 size={13} />{selectedApp.currentCompany}</span>}
                      </div>
                    )}
                  </div>

                  {/* Status Pipeline */}
                  <div className="bg-[#FEFCF7] rounded-xl p-4">
                    <p className="text-xs font-medium text-[#7A7A7A] mb-3">Application Pipeline</p>
                    <div className="flex items-center gap-1">
                      {appStatusSteps.map((step, i) => {
                        const currentIdx = appStatusSteps.indexOf(selectedApp.status);
                        const isActive = i <= currentIdx;
                        const isCurrent = step === selectedApp.status;
                        return (
                          <button key={step} onClick={() => updateAppStatus(selectedApp.id, step)}
                            className={`flex-1 py-1.5 rounded text-[10px] font-medium transition-all ${isCurrent ? "bg-[#1A1A1A] text-white" : isActive ? "bg-[rgba(245,213,71,0.3)] text-[#1A1A1A]" : "bg-white border border-[#E8E0D0] text-[#B0B0B0] hover:border-[#F5D547] hover:text-[#7A7A7A]"}`}
                          >{step === "RECEIVED" ? "New" : step.charAt(0) + step.slice(1).toLowerCase()}</button>
                        );
                      })}
                    </div>
                    {selectedApp.status !== "REJECTED" ? (
                      <button onClick={() => updateAppStatus(selectedApp.id, "REJECTED")}
                        className="mt-2 flex items-center gap-1 text-xs text-red-500 hover:text-red-700">
                        <XCircle size={13} />Reject Applicant
                      </button>
                    ) : (
                      <button onClick={() => updateAppStatus(selectedApp.id, "RECEIVED")}
                        className="mt-2 flex items-center gap-1 text-xs text-green-600 hover:text-green-700">
                        <CheckCircle size={13} />Reopen Application
                      </button>
                    )}
                  </div>

                  {/* Quick Actions: Resume, LinkedIn, Portfolio */}
                  <div className="grid grid-cols-3 gap-3">
                    {selectedApp.resumeUrl ? (
                      <a href={`${API_BASE}${selectedApp.resumeUrl}`} target="_blank" rel="noopener noreferrer"
                        className="flex items-center justify-center gap-2 p-3 rounded-xl border border-[#E8E0D0] hover:border-[#F5D547] hover:bg-[rgba(245,213,71,0.08)] transition-colors">
                        <FileText size={16} className="text-red-500" />
                        <span className="text-sm font-medium">View CV</span>
                        <ExternalLink size={12} className="text-[#B0B0B0]" />
                      </a>
                    ) : (
                      <div className="flex items-center justify-center gap-2 p-3 rounded-xl border border-[#E8E0D0] bg-gray-50 text-[#B0B0B0]">
                        <FileText size={16} /><span className="text-sm">No Resume</span>
                      </div>
                    )}
                    {selectedApp.linkedinUrl ? (
                      <a href={selectedApp.linkedinUrl} target="_blank" rel="noopener noreferrer"
                        className="flex items-center justify-center gap-2 p-3 rounded-xl border border-[#E8E0D0] hover:border-[#0077B5] hover:bg-[rgba(0,119,181,0.05)] transition-colors">
                        <Linkedin size={16} className="text-[#0077B5]" />
                        <span className="text-sm font-medium">LinkedIn</span>
                        <ExternalLink size={12} className="text-[#B0B0B0]" />
                      </a>
                    ) : (
                      <div className="flex items-center justify-center gap-2 p-3 rounded-xl border border-[#E8E0D0] bg-gray-50 text-[#B0B0B0]">
                        <Linkedin size={16} /><span className="text-sm">No LinkedIn</span>
                      </div>
                    )}
                    {selectedApp.portfolioUrl ? (
                      <a href={selectedApp.portfolioUrl} target="_blank" rel="noopener noreferrer"
                        className="flex items-center justify-center gap-2 p-3 rounded-xl border border-[#E8E0D0] hover:border-[#F5D547] hover:bg-[rgba(245,213,71,0.08)] transition-colors">
                        <Globe size={16} className="text-purple-500" />
                        <span className="text-sm font-medium">Portfolio</span>
                        <ExternalLink size={12} className="text-[#B0B0B0]" />
                      </a>
                    ) : (
                      <div className="flex items-center justify-center gap-2 p-3 rounded-xl border border-[#E8E0D0] bg-gray-50 text-[#B0B0B0]">
                        <Globe size={16} /><span className="text-sm">No Portfolio</span>
                      </div>
                    )}
                  </div>

                  {/* Cover Letter */}
                  {selectedApp.coverLetter && (
                    <div>
                      <p className="text-xs font-medium text-[#7A7A7A] mb-2">Cover Letter</p>
                      <div className="bg-[#FEFCF7] rounded-xl p-4 text-sm text-[#555] whitespace-pre-line leading-relaxed">
                        {selectedApp.coverLetter}
                      </div>
                    </div>
                  )}

                  {/* Admin Notes */}
                  <div>
                    <p className="text-xs font-medium text-[#7A7A7A] mb-2">Review Notes</p>
                    <textarea value={notesText} onChange={(e) => setNotesText(e.target.value)}
                      placeholder="Add internal notes about this applicant..." rows={3} className={inputClass + " resize-none"} />
                    <div className="flex justify-end mt-2">
                      <button onClick={() => saveNotes(selectedApp.id)} disabled={savingNotes}
                        className="bg-[#1A1A1A] text-white py-1.5 px-4 rounded-full text-xs font-medium hover:bg-[#2B2B2B] disabled:opacity-50">
                        {savingNotes ? "Saving..." : "Save Notes"}
                      </button>
                    </div>
                  </div>

                  <p className="text-xs text-[#B0B0B0]">Applied on {new Date(selectedApp.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===== JOBS VIEW ===== */}
      {view === "jobs" && (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0]">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#F0EAD8]">
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Title</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Department</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Location</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Type</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Status</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Applicants</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {jobs.length === 0 ? (
                  <tr><td colSpan={7} className="p-8 text-center text-[#7A7A7A]"><Briefcase size={24} className="mx-auto mb-2 opacity-30" />No job listings yet.</td></tr>
                ) : jobs.map((job: any) => (
                  <tr key={job.id} className="border-b border-[#F0EAD8] last:border-0 hover:bg-[rgba(255,248,225,0.5)] transition-colors">
                    <td className="p-4 font-medium text-[#1A1A1A]">{job.title}</td>
                    <td className="p-4 text-[#7A7A7A]">{job.department || "—"}</td>
                    <td className="p-4 text-[#7A7A7A]">{job.location || "—"}</td>
                    <td className="p-4 text-[#7A7A7A]">{formatStatus(job.type)}</td>
                    <td className="p-4"><span className={`px-2.5 py-1 rounded-full text-xs font-medium ${statusColors[job.status] || ""}`}>{formatStatus(job.status)}</span></td>
                    <td className="p-4">
                      <button onClick={() => { setAppJobFilter(job.id); setView("applications"); }}
                        className="flex items-center gap-1 text-sm font-semibold text-blue-600 hover:text-blue-800">
                        {job._count?.applications ?? 0} <Eye size={13} />
                      </button>
                    </td>
                    <td className="p-4">
                      <div className="flex items-center gap-2">
                        <button onClick={() => startEdit(job)} className="text-xs text-[#7A7A7A] hover:text-[#1A1A1A] font-medium">Edit</button>
                        {job.status === "ACTIVE" ? (
                          <button onClick={() => toggleJobStatus(job.id, "PAUSED")} className="text-xs text-[#7A7A7A] hover:text-yellow-600">Pause</button>
                        ) : job.status !== "CLOSED" ? (
                          <button onClick={() => toggleJobStatus(job.id, "ACTIVE")} className="text-xs text-[#7A7A7A] hover:text-green-600">Activate</button>
                        ) : null}
                        {job.status === "ACTIVE" && (
                          <button onClick={() => toggleJobStatus(job.id, "CLOSED")} className="text-xs text-[#7A7A7A] hover:text-red-600">Close</button>
                        )}
                        <button onClick={() => setDeleteJobId(job.id)} className="text-xs text-[#7A7A7A] hover:text-red-600"><Trash2 size={13} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!deleteJobId}
        title="Delete job listing?"
        description="This cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDeleteJob}
        onCancel={() => setDeleteJobId(null)}
      />
    </div>
  );
}
