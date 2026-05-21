"use client";
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR from "swr";
import { Topstrip } from "@/components/portal-shell";
import { AlertCircle, Send, MessageSquare, Check } from "lucide-react";

const CATEGORIES = ["GENERAL", "WORKPLACE", "HARASSMENT", "SALARY", "LEAVE", "INFRASTRUCTURE", "OTHER"];

const statusBadge: Record<string, string> = {
  OPEN: "bg-attention-bg text-attention border-attention/20",
  IN_REVIEW: "bg-indigo-soft text-indigo border-indigo/20",
  RESOLVED: "bg-success-bg text-success border-success/20",
  CLOSED: "bg-muted text-ink-3 border-ink/10",
};

export default function ComplaintsPage() {
  const { data, mutate } = useSWR("/hr/complaints", (url: string) => apiFetch<any>(url));
  const complaints = data?.data || [];
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ subject: "", description: "", category: "GENERAL" });
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await apiFetch("/hr/complaints", { method: "POST", body: JSON.stringify(form) });
      setForm({ subject: "", description: "", category: "GENERAL" });
      setShowForm(false);
      mutate();
    } catch (e: any) { alert(e.message); }
    setSubmitting(false);
  }

  const inputClass = "w-full h-10 px-3 text-[13px] font-medium rounded-xl bg-bg border-2 border-ink/10 focus:border-indigo outline-none transition-colors";
  const textareaClass = "w-full px-3 py-2.5 text-[13px] font-medium rounded-xl bg-bg border-2 border-ink/10 focus:border-indigo outline-none transition-colors resize-none";

  return (
    <>
      <Topstrip
        title="Complaints"
        sub="Submit and track your complaints or issues"
        right={
          <button
            onClick={() => setShowForm(!showForm)}
            className="btn-3d inline-flex items-center gap-2 px-5 h-10 rounded-xl bg-ink text-white text-[13px] font-semibold border-2 border-ink"
          >
            {showForm ? "Cancel" : "New Complaint"}
          </button>
        }
      />
      <div className="px-6 py-6 flex-1 overflow-y-auto max-w-[900px] space-y-4">

        {showForm && (
          <form onSubmit={handleSubmit} className="v3-card">
            <div className="px-5 h-12 flex items-center" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
              <AlertCircle className="w-4 h-4 text-ink-3 mr-2" />
              <span className="text-[13px] font-semibold text-ink">Submit a Complaint</span>
            </div>
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <p className="text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Subject *</p>
                  <input
                    type="text"
                    placeholder="Brief subject..."
                    value={form.subject}
                    onChange={(e) => setForm({ ...form, subject: e.target.value })}
                    required
                    className={inputClass}
                  />
                </div>
                <div>
                  <p className="text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Category</p>
                  <select
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                    className={inputClass}
                  >
                    {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <p className="text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Description *</p>
                <textarea
                  placeholder="Describe your complaint in detail..."
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  required
                  rows={5}
                  className={textareaClass}
                />
              </div>
              <p className="text-[12px] text-ink-4">All complaints are handled confidentially by HR.</p>
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={submitting}
                  className="btn-3d inline-flex items-center gap-2 px-5 h-10 rounded-xl bg-ink text-white text-[13px] font-semibold border-2 border-ink disabled:opacity-50"
                >
                  <Send className="h-4 w-4" /> {submitting ? "Submitting..." : "Submit Complaint"}
                </button>
              </div>
            </div>
          </form>
        )}

        {complaints.length === 0 ? (
          <div className="v3-card p-12 text-center">
            <MessageSquare className="h-9 w-9 mx-auto mb-3 text-ink-4" />
            <p className="text-[13px] text-ink-3 font-medium">No complaints submitted yet</p>
          </div>
        ) : (
          <div className="v3-card">
            <div className="px-5 h-12 flex items-center" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
              <span className="text-[13px] font-semibold text-ink">Your Complaints</span>
              <span className="ml-2 h-5 w-5 rounded-full bg-muted text-ink-3 text-[11px] font-bold flex items-center justify-center">{complaints.length}</span>
            </div>
            <div className="px-5 py-3 space-y-1">
              {complaints.map((c: any) => (
                <div key={c.id} className="v3-row px-4 py-3.5 rounded-xl">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <p className="text-[13px] font-semibold text-ink">{c.subject}</p>
                      <p className="text-[11px] text-ink-4 font-medium mt-0.5">
                        {c.category} &middot;{" "}
                        {new Date(c.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                      </p>
                    </div>
                    <span className={`inline-flex h-6 px-2.5 rounded-full text-[11px] font-semibold items-center border ${statusBadge[c.status] || "bg-muted text-ink-3 border-ink/10"}`}>
                      {c.status.replace("_", " ")}
                    </span>
                  </div>
                  <p className="text-[13px] text-ink-3 whitespace-pre-wrap leading-relaxed">{c.description}</p>
                  {c.adminResponse && (
                    <div className="mt-3 bg-success-bg border border-success/15 rounded-xl p-3.5">
                      <p className="text-[11.5px] font-bold text-success uppercase tracking-wider mb-1 flex items-center gap-1">
                        <Check className="h-3 w-3" /> Admin Response
                      </p>
                      <p className="text-[13px] text-ink">{c.adminResponse}</p>
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
