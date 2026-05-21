"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR from "swr";
import { Topstrip } from "@/components/portal-shell";
import { Bug, Plus, ChevronUp, CheckCircle } from "lucide-react";

const severityBadge: Record<string, string> = {
  LOW: "bg-indigo-soft text-indigo border-indigo/20",
  MEDIUM: "bg-attention-bg text-attention border-attention/20",
  HIGH: "bg-danger-bg text-danger border-danger/20",
  CRITICAL: "bg-danger-bg text-danger border-danger/30",
};

const statusBadge: Record<string, string> = {
  OPEN: "bg-danger-bg text-danger border-danger/20",
  IN_PROGRESS: "bg-attention-bg text-attention border-attention/20",
  RESOLVED: "bg-success-bg text-success border-success/20",
  CLOSED: "bg-muted text-ink-3 border-ink/10",
  WONT_FIX: "bg-muted text-ink-4 border-ink/10",
};

export default function BugReportPage() {
  const [showForm, setShowForm] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ title: "", description: "", page: "", severity: "MEDIUM" });
  const [success, setSuccess] = useState("");

  const { data, mutate } = useSWR("/hr/bug-reports", apiFetch);
  const bugs = (data as any)?.data || [];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await apiFetch("/hr/bug-reports", { method: "POST", body: JSON.stringify(form) });
      setForm({ title: "", description: "", page: "", severity: "MEDIUM" });
      setShowForm(false);
      setSuccess("Bug report submitted! Admin will review it.");
      setTimeout(() => setSuccess(""), 5000);
      mutate();
    } catch (e: any) { alert(e.message); }
    finally { setSubmitting(false); }
  }

  const inputClass = "w-full h-10 px-3 text-[13px] font-medium rounded-xl bg-bg border-2 border-ink/10 focus:border-indigo outline-none transition-colors";
  const textareaClass = "w-full px-3 py-2.5 text-[13px] font-medium rounded-xl bg-bg border-2 border-ink/10 focus:border-indigo outline-none transition-colors resize-none";

  return (
    <>
      <Topstrip
        title="Report a Bug"
        sub="Found something broken? Let us know!"
        right={
          <button
            onClick={() => setShowForm((p) => !p)}
            className="btn-3d inline-flex items-center gap-2 px-5 h-10 rounded-xl bg-ink text-white text-[13px] font-semibold border-2 border-ink"
          >
            {showForm ? <ChevronUp size={14} /> : <Plus size={14} />}
            {showForm ? "Close" : "Report Bug"}
          </button>
        }
      />
      <div className="px-6 py-6 flex-1 overflow-y-auto max-w-[900px] space-y-4">

        {success && (
          <div className="flex items-center gap-2 bg-success-bg border border-success/20 text-success px-4 py-3 rounded-xl text-[13px] font-medium">
            <CheckCircle className="h-4 w-4" />
            {success}
          </div>
        )}

        {showForm && (
          <form onSubmit={handleSubmit} className="v3-card">
            <div className="px-5 h-12 flex items-center gap-2" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
              <Bug className="w-4 h-4 text-ink-3" />
              <span className="text-[13px] font-semibold text-ink">New Bug Report</span>
            </div>
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <p className="text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Bug Title *</p>
                  <input
                    type="text"
                    value={form.title}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                    required
                    placeholder="Brief description of the issue"
                    className={inputClass}
                  />
                </div>
                <div>
                  <p className="text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Page / Section</p>
                  <input
                    type="text"
                    value={form.page}
                    onChange={(e) => setForm({ ...form, page: e.target.value })}
                    placeholder="Where did you find the bug?"
                    className={inputClass}
                  />
                </div>
              </div>
              <div>
                <p className="text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Severity</p>
                <select
                  value={form.severity}
                  onChange={(e) => setForm({ ...form, severity: e.target.value })}
                  className={inputClass}
                >
                  <option value="LOW">Low — Minor UI issue</option>
                  <option value="MEDIUM">Medium — Feature not working properly</option>
                  <option value="HIGH">High — Major feature broken</option>
                  <option value="CRITICAL">Critical — System down / data loss</option>
                </select>
              </div>
              <div>
                <p className="text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Description *</p>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  required
                  rows={4}
                  placeholder="Steps to reproduce the bug, what you expected, and what happened instead..."
                  className={textareaClass}
                />
              </div>
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={submitting}
                  className="btn-3d inline-flex items-center gap-2 px-5 h-10 rounded-xl bg-ink text-white text-[13px] font-semibold border-2 border-ink disabled:opacity-50"
                >
                  {submitting ? "Submitting..." : "Submit Bug Report"}
                </button>
              </div>
            </div>
          </form>
        )}

        {/* Bug List */}
        {bugs.length === 0 ? (
          <div className="v3-card p-10 text-center">
            <Bug className="h-8 w-8 mx-auto mb-2 text-ink-4" />
            <p className="text-[13px] text-ink-3 font-medium">No bug reports yet</p>
          </div>
        ) : (
          <div className="v3-card">
            <div className="px-5 h-12 flex items-center" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
              <span className="text-[13px] font-semibold text-ink">Your Bug Reports</span>
              <span className="ml-2 h-5 w-5 rounded-full bg-muted text-ink-3 text-[11px] font-bold flex items-center justify-center">{bugs.length}</span>
            </div>
            <div className="px-5 py-3 space-y-1">
              {bugs.map((bug: any) => (
                <div key={bug.id} className="v3-row px-4 py-3.5 rounded-xl space-y-1.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold text-ink truncate">{bug.title}</p>
                      <p className="text-[11px] text-ink-4 font-medium mt-0.5">
                        {bug.page ? `${bug.page} · ` : ""}{new Date(bug.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex gap-1.5 shrink-0">
                      <span className={`inline-flex h-6 px-2.5 rounded-full text-[11px] font-semibold items-center border ${severityBadge[bug.severity] || ""}`}>
                        {bug.severity}
                      </span>
                      <span className={`inline-flex h-6 px-2.5 rounded-full text-[11px] font-semibold items-center border ${statusBadge[bug.status] || ""}`}>
                        {bug.status.replace("_", " ")}
                      </span>
                    </div>
                  </div>
                  <p className="text-[13px] text-ink-3 line-clamp-2 leading-relaxed">{bug.description}</p>
                  {bug.resolution && (
                    <div className="bg-success-bg rounded-xl px-3 py-2 text-[12px] text-success font-medium">
                      <strong>Resolution:</strong> {bug.resolution}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
