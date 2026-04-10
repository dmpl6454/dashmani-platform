"use client";
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR from "swr";
import { AlertCircle, Send, MessageSquare, Check } from "lucide-react";

const inputClass = "w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors";

const CATEGORIES = ["GENERAL", "WORKPLACE", "HARASSMENT", "SALARY", "LEAVE", "INFRASTRUCTURE", "OTHER"];

const statusColors: Record<string, string> = {
  OPEN: "bg-yellow-50 text-yellow-700",
  IN_REVIEW: "bg-blue-50 text-blue-700",
  RESOLVED: "bg-green-50 text-green-700",
  CLOSED: "bg-gray-100 text-gray-600",
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

  return (
    <div className="min-h-screen bg-[#FEFCF7] p-6 md:p-10 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-light text-[#1A1A1A] font-serif flex items-center gap-3">
            <AlertCircle className="h-8 w-8 text-[#F5D547]" /> Complaints
          </h1>
          <p className="text-sm text-[#888] mt-1">Submit and track your complaints or issues</p>
        </div>
        <button onClick={() => setShowForm(!showForm)} className="bg-[#1A1A1A] text-white py-2.5 px-5 rounded-full text-sm font-semibold hover:bg-[#2B2B2B] transition-all">
          {showForm ? "Cancel" : "New Complaint"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-6 space-y-4">
          <h2 className="text-lg font-semibold text-[#1A1A1A]">Submit a Complaint</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <input type="text" placeholder="Subject *" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} required className={inputClass} />
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className={inputClass}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <textarea placeholder="Describe your complaint in detail... *" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} required rows={5} className={`${inputClass} resize-none`} />
          <p className="text-xs text-[#7A7A7A]">Your complaint will be reviewed by HR. All complaints are handled confidentially.</p>
          <div className="flex justify-end">
            <button type="submit" disabled={submitting} className="flex items-center gap-2 bg-[#1A1A1A] text-white py-2.5 px-6 rounded-full text-sm font-semibold hover:bg-[#2B2B2B] disabled:opacity-50 transition-all">
              <Send className="h-4 w-4" /> {submitting ? "Submitting..." : "Submit Complaint"}
            </button>
          </div>
        </form>
      )}

      {complaints.length === 0 ? (
        <div className="bg-white rounded-2xl border border-[#E8E0D0] p-12 text-center">
          <MessageSquare className="h-12 w-12 mx-auto mb-3 text-[#E8E0D0]" />
          <p className="text-[#B0B0B0]">No complaints submitted yet</p>
        </div>
      ) : (
        <div className="space-y-4">
          {complaints.map((c: any) => (
            <div key={c.id} className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-5">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-semibold text-[#1A1A1A]">{c.subject}</h3>
                  <p className="text-xs text-[#7A7A7A] mt-0.5">{c.category} · {new Date(c.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</p>
                </div>
                <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${statusColors[c.status] || "bg-gray-100"}`}>{c.status.replace("_", " ")}</span>
              </div>
              <p className="text-sm text-[#555] whitespace-pre-wrap">{c.description}</p>
              {c.adminResponse && (
                <div className="mt-4 bg-[#FEFCF7] border border-[#F0EAD8] rounded-xl p-4">
                  <p className="text-xs font-semibold text-[#7A7A7A] mb-1 flex items-center gap-1"><Check className="h-3 w-3" /> Admin Response</p>
                  <p className="text-sm text-[#1A1A1A]">{c.adminResponse}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
