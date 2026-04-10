"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR from "swr";
import { Bug, Plus, ChevronUp, CheckCircle } from "lucide-react";

const inputClass = "w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors";

const severityColors: Record<string, string> = {
  LOW: "bg-blue-50 text-blue-700", MEDIUM: "bg-yellow-50 text-yellow-700",
  HIGH: "bg-orange-50 text-orange-700", CRITICAL: "bg-red-50 text-red-700",
};
const statusColors: Record<string, string> = {
  OPEN: "bg-red-50 text-red-700", IN_PROGRESS: "bg-yellow-50 text-yellow-700",
  RESOLVED: "bg-green-50 text-green-700", CLOSED: "bg-gray-100 text-gray-700",
  WONT_FIX: "bg-gray-100 text-gray-600",
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

  return (
    <div className="min-h-screen bg-[#FEFCF7] p-6 md:p-10 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-light text-[#1A1A1A] font-serif">Report a Bug</h1>
          <p className="text-sm text-[#888] mt-1">Found something broken? Let us know!</p>
        </div>
        <button onClick={() => setShowForm((p) => !p)} className="bg-[#1A1A1A] text-white py-2.5 px-6 rounded-full font-semibold hover:bg-[#2B2B2B] transition-all flex items-center gap-2">
          {showForm ? <ChevronUp size={16} /> : <Plus size={16} />}
          {showForm ? "Close" : "Report Bug"}
        </button>
      </div>

      {success && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-3 flex items-center gap-2">
          <CheckCircle className="h-4 w-4 text-green-600" />
          <p className="text-sm text-green-700">{success}</p>
        </div>
      )}

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Bug Title *</label>
              <input type="text" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required placeholder="Brief description of the issue" className={inputClass} />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Page/Section</label>
              <input type="text" value={form.page} onChange={(e) => setForm({ ...form, page: e.target.value })} placeholder="Where did you find the bug?" className={inputClass} />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Severity</label>
            <select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })} className={inputClass}>
              <option value="LOW">Low - Minor UI issue</option>
              <option value="MEDIUM">Medium - Feature not working properly</option>
              <option value="HIGH">High - Major feature broken</option>
              <option value="CRITICAL">Critical - System down / data loss</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Description *</label>
            <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} required rows={4} placeholder="Steps to reproduce the bug, what you expected, and what happened instead..." className={inputClass + " resize-none"} />
          </div>
          <div className="flex justify-end">
            <button type="submit" disabled={submitting} className="bg-[#1A1A1A] text-white py-2.5 px-6 rounded-full font-semibold hover:bg-[#2B2B2B] disabled:opacity-50">
              {submitting ? "Submitting..." : "Submit Bug Report"}
            </button>
          </div>
        </form>
      )}

      {/* Bug List */}
      <div className="space-y-3">
        {bugs.length === 0 ? (
          <div className="bg-white rounded-2xl border border-[#E8E0D0] p-8 text-center text-[#888]">
            <Bug className="h-8 w-8 mx-auto mb-2 text-[#C4B89C]" />
            No bug reports yet
          </div>
        ) : bugs.map((bug: any) => (
          <div key={bug.id} className="bg-white rounded-xl border border-[#E8E0D0] p-4 space-y-2">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="font-semibold text-sm text-[#1A1A1A]">{bug.title}</h3>
                <p className="text-xs text-[#888]">{bug.page ? `Page: ${bug.page} · ` : ""}{new Date(bug.createdAt).toLocaleDateString()}</p>
              </div>
              <div className="flex gap-2">
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${severityColors[bug.severity] || ""}`}>{bug.severity}</span>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${statusColors[bug.status] || ""}`}>{bug.status}</span>
              </div>
            </div>
            <p className="text-sm text-[#555] line-clamp-2">{bug.description}</p>
            {bug.resolution && (
              <div className="bg-green-50 rounded-lg p-2 text-xs text-green-700">
                <strong>Resolution:</strong> {bug.resolution}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
